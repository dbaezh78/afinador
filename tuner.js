/**
 * tuner.js — Guitar Tuner
 * Fixes v2:
 *  • No red fret lines — silver/ivory frets drawn correctly
 *  • Needle pivot centred with indicator light (cy = H − 35)
 *  • Strings play Karplus-Strong pluck sound on tap
 *  • Note wheel scrolls horizontally with CSS transition
 */
'use strict';

// ═══════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════

/** Guitar strings: index 0 = thickest (Mi2), index 5 = thinnest (Mi4) */
const GUITAR_STRINGS = [
  { name: 'Mi',  octave: 2, note: 'E2',  freq: 82.41  },
  { name: 'La',  octave: 2, note: 'A2',  freq: 110.00 },
  { name: 'Re',  octave: 3, note: 'D3',  freq: 146.83 },
  { name: 'Sol', octave: 3, note: 'G3',  freq: 196.00 },
  { name: 'Si',  octave: 3, note: 'B3',  freq: 246.94 },
  { name: 'Mi',  octave: 4, note: 'E4',  freq: 329.63 },
];

const NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
/** Triple the notes array for infinite-scroll feel */
const NOTES_TRIPLE = [...NOTES, ...NOTES, ...NOTES];

const A4_FREQ        = 440;
const A4_MIDI        = 69;
const IN_TUNE_CENTS  = 5;
const CLOSE_CENTS    = 15;
const FFT_SIZE       = 4096;
const MIN_CONF       = 0.90;
const CELL_W         = 72;   // must match CSS --cell-w

// ═══════════════════════════════════════════════════════
//  EXACT REFERENCE FREQUENCIES (Equal temperament, A4=440)
// ═══════════════════════════════════════════════════════
const NOTE_FREQS = {
  'C': 261.63, 'C#': 277.18, 'D': 293.66, 'D#': 311.13,
  'E': 329.63, 'F': 349.23, 'F#': 369.99, 'G': 392.00,
  'G#': 415.30, 'A': 440.00, 'A#': 466.16, 'B': 493.88
};

// ═══════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════
let audioCtx = null;
let analyser, sourceNode, timeDomainBuf;
let isRunning    = false;
let lockedString = null;
let animFrame;

let displayCents  = 0;
let displayNote   = 'E';
let displayOctave = 4;       // octave of the detected note
let needleAngle   = 0;
let targetAngle   = 0;

// ── Note stability: vote from last N frames before committing a note change ──
const NOTE_HIST_SIZE = 14;   // frames to average
let   noteHistory    = [];   // [{note, octave}]

// String vibration state
let vibrationEnabled  = true;
const activeVibrations = new Map();

// ═══════════════════════════════════════════════════════
//  DOM REFS
// ═══════════════════════════════════════════════════════
const meterCanvas    = document.getElementById('meter-canvas');
const mCtx           = meterCanvas.getContext('2d');
const indicatorLight = document.getElementById('indicator-light');
const noteTrackEl    = document.getElementById('note-track');
const noteWheelEl    = document.getElementById('note-wheel');
const stringsList    = document.getElementById('strings-list');
const fretCanvas     = document.getElementById('fretboard-canvas');
const fCtx           = fretCanvas.getContext('2d');

// ═══════════════════════════════════════════════════════
//  BOOTSTRAP
// ═══════════════════════════════════════════════════════
function init() {
  buildNoteTrack();
  buildFretboard();
  resizeCanvases();
  updateNoteWheel('E', 0);
  showMicOverlay();

  window.addEventListener('resize', () => {
    resizeCanvases();
    drawFretboardBg();
    // redraw meter on next frame (needleAngle already set)
  });
}

// ═══════════════════════════════════════════════════════
//  MIC OVERLAY
// ═══════════════════════════════════════════════════════
function showMicOverlay() {
  const overlay = document.createElement('div');
  overlay.id = 'mic-overlay';
  overlay.innerHTML = `
    <h2>🎙 Micrófono requerido</h2>
    <p>El afinador necesita acceso al micrófono.<br>
       También puedes tocar las cuerdas para escucharlas.</p>
    <button id="mic-btn">Activar afinador</button>
  `;
  document.body.appendChild(overlay);
  document.getElementById('mic-btn').addEventListener('click', startTuner);
}

// ═══════════════════════════════════════════════════════
//  NOTE WHEEL — horizontal scrolling track
// ═══════════════════════════════════════════════════════
function formatNoteHtml(note) {
  if (note.includes('#')) {
    return `${note[0]}<sup style="font-size:0.6em;vertical-align:super">#</sup>`;
  }
  return note;
}

function buildNoteTrack() {
  noteTrackEl.innerHTML = '';
  NOTES_TRIPLE.forEach((note) => {
    const cell = document.createElement('div');
    cell.className = 'note-cell';
    cell.innerHTML = formatNoteHtml(note);
    noteTrackEl.appendChild(cell);
  });
}

let lastNoteIdx = -1; // track which index was last centred

// DOM refs for the LCD display inside the indicator circle
const nicNote   = document.getElementById('nic-note');
const nicOct    = document.getElementById('nic-oct');
const freqValEl = document.getElementById('freq-val');

function updateNoteWheel(note, cents, octave = 4, frequency = null) {
  const baseIdx = NOTES.indexOf(note);
  if (baseIdx === -1) return;

  // Always scroll to the middle copy (offset 12)
  const targetIdx = 12 + baseIdx;

  const wheelW     = noteWheelEl.offsetWidth;
  const translateX = wheelW / 2 - (targetIdx + 0.5) * CELL_W;

  noteTrackEl.style.transform = `translateX(${Math.round(translateX)}px)`;

  // Update cell classes only when note actually changes
  if (targetIdx !== lastNoteIdx) {
    lastNoteIdx = targetIdx;
    const cells = noteTrackEl.querySelectorAll('.note-cell');
    cells.forEach((cell, i) => {
      const dist = Math.abs(i - targetIdx);
      cell.className = 'note-cell';
      if      (dist === 0) cell.classList.add('is-current');
      else if (dist === 1) cell.classList.add('near-1');
      else if (dist === 2) cell.classList.add('near-2');
    });

    // Update LCD display inside the indicator circle
    if (nicNote) nicNote.textContent = note;
    if (nicOct)  nicOct.textContent  = octave;
  }

  // Update frequency (Hz / exact tuning pitch) readout below circle
  if (freqValEl) {
    if (frequency && frequency > 0) {
      freqValEl.textContent = frequency.toFixed(1);
    } else if (NOTE_FREQS[note]) {
      // Calculate octave adjusted frequency based on standard table
      const baseFreq = NOTE_FREQS[note]; // 4th octave (e.g. A4=440)
      const octOffset = octave - 4;
      const targetHz = baseFreq * Math.pow(2, octOffset);
      freqValEl.textContent = targetHz.toFixed(1);
    }
  }

  // Indicator light colour
  const abs = Math.abs(cents);
  if      (abs <= IN_TUNE_CENTS) indicatorLight.className = 'light-green';
  else if (abs <= CLOSE_CENTS)   indicatorLight.className = 'light-yellow';
  else                            indicatorLight.className = 'light-red';
}

// ═══════════════════════════════════════════════════════
//  FRETBOARD
// ═══════════════════════════════════════════════════════
function buildFretboard() {
  // Display thinnest (Mi4) first, thickest (Mi2) last
  const display = [...GUITAR_STRINGS].reverse();

  display.forEach((str, visIdx) => {
    const origIdx = GUITAR_STRINGS.length - 1 - visIdx;
    const row = document.createElement('div');
    row.className = 'string-row';
    row.dataset.idx = origIdx;

    // String thickness: visIdx 0 = thinnest (1.5 px), 5 = thickest (5 px)
    const sw = [1.5, 2, 2.5, 3.2, 4, 5][visIdx];

    row.innerHTML = `
      <div class="string-peg">
        <span class="note-name">${str.name}</span><span class="octave">${str.octave}</span>
      </div>
      <div class="string-line-wrap">
        <div class="string-line" style="--sw:${sw}px"></div>
        <canvas class="string-vibe-canvas"></canvas>
      </div>
    `;

    row.addEventListener('click', () => handleStringTap(origIdx, row));
    stringsList.appendChild(row);
  });
}

function handleStringTap(idx, rowEl) {
  // Improved guitar sound
  playKarplusStrong(GUITAR_STRINGS[idx].freq, idx);

  // Visual vibration
  startStringVibration(idx, rowEl);

  // Toggle string lock
  document.querySelectorAll('.string-row').forEach(r => r.classList.remove('active'));
  if (lockedString === idx) {
    lockedString = null;
  } else {
    lockedString = idx;
    rowEl.classList.add('active');
    const s = GUITAR_STRINGS[idx];
    const noteName = s.note.replace(/\d/, '');
    displayNote = noteName;
    updateNoteWheel(noteName, 0);
  }
}

// ═══════════════════════════════════════════════════════
//  AUDIO — ensure context exists
// ═══════════════════════════════════════════════════════
function ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

// ── Improved Karplus-Strong — guitar-optimised ────────
/**
 * @param {number} freq       - Target frequency in Hz
 * @param {number} stringIdx  - 0 (E2, thickest) … 5 (E4, thinnest)
 */
function playKarplusStrong(freq, stringIdx = 3) {
  ensureAudioCtx();

  const sr      = audioCtx.sampleRate;
  const period  = Math.round(sr / freq);

  // String characteristics
  // Lower (wound) strings: darker tone, longer sustain
  const isWound   = stringIdx <= 2;
  const pickPos   = isWound ? 0.12 : 0.18;   // closer to bridge = brighter
  const damping   = isWound
    ? 0.4975 + stringIdx * 0.0002            // wound  → slightly less damping
    : 0.4970 - (stringIdx - 3) * 0.0002;    // plain  → slightly more damping
  const duration  = 3.5 - stringIdx * 0.25;  // thicker strings sustain longer
  const totalSamps = Math.round(sr * duration);

  const offBuf = audioCtx.createBuffer(1, totalSamps, sr);
  const data   = offBuf.getChannelData(0);

  // ── Excitation: white noise pre-filtered by pick position ──
  const ring = new Float32Array(period);
  for (let i = 0; i < period; i++) ring[i] = Math.random() * 2 - 1;

  // Moving-average passes simulate the pick-position filter:
  // fewer passes = brighter (bridge pick), more = darker (neck pick)
  const passes = Math.max(1, Math.round(pickPos * period * 0.8));
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < period; i++) {
      ring[i] = 0.5 * (ring[i] + ring[(i + 1) % period]);
    }
  }

  // ── Karplus-Strong main loop ──
  for (let i = 0; i < totalSamps; i++) {
    const i0 = i % period;
    const i1 = (i + 1) % period;
    ring[i0]  = damping * (ring[i0] + ring[i1]);
    data[i]   = ring[i0];
  }

  const src  = audioCtx.createBufferSource();
  src.buffer = offBuf;

  // Attack-decay gain envelope
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0, audioCtx.currentTime);
  gain.gain.linearRampToValueAtTime(0.72, audioCtx.currentTime + 0.003);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);

  // Low-pass: remove aliasing, tune brightness per string
  const lp = audioCtx.createBiquadFilter();
  lp.type            = 'lowpass';
  lp.frequency.value = isWound ? Math.min(freq * 12, 8000) : Math.min(freq * 9, 6500);
  lp.Q.value         = 0.8;

  // Body resonance peak (~200-400 Hz for low strings, ~600 Hz for high)
  const body = audioCtx.createBiquadFilter();
  body.type            = 'peaking';
  body.frequency.value = isWound ? 250 + stringIdx * 40 : 600 + stringIdx * 80;
  body.gain.value      = isWound ? 4 : 2.5;
  body.Q.value         = 1.8;

  // Slight high-frequency presence boost for plain strings
  let chain = src;
  src.connect(body);
  body.connect(lp);
  lp.connect(gain);
  gain.connect(audioCtx.destination);

  src.start();
  src.stop(audioCtx.currentTime + duration);
}

// ═══════════════════════════════════════════════════════
//  STRING VIBRATION  — standing-wave animation
// ═══════════════════════════════════════════════════════
/**
 * Draws a decaying standing-wave on the string-vibe-canvas overlaid on the
 * string row. Cancelled automatically when vibrationEnabled is false.
 *
 * @param {number}      stringIdx  - 0…5 (thickest to thinnest)
 * @param {HTMLElement} rowEl      - .string-row element
 */
function startStringVibration(stringIdx, rowEl) {
  if (!vibrationEnabled) return;

  // Cancel any previous vibration on this string
  if (activeVibrations.has(stringIdx)) {
    cancelAnimationFrame(activeVibrations.get(stringIdx));
    activeVibrations.delete(stringIdx);
  }

  const vibeCanvas = rowEl.querySelector('.string-vibe-canvas');
  const stringLine = rowEl.querySelector('.string-line');
  if (!vibeCanvas || !stringLine) return;

  // Get dimensions from the wrap (parent of canvas)
  const wrap  = vibeCanvas.parentElement;
  const wRect = wrap.getBoundingClientRect();
  const dpr   = window.devicePixelRatio || 1;
  const W     = wRect.width;
  const H     = wRect.height;

  vibeCanvas.width        = Math.round(W * dpr);
  vibeCanvas.height       = Math.round(H * dpr);
  vibeCanvas.style.width  = W + 'px';
  vibeCanvas.style.height = H + 'px';

  const vCtx = vibeCanvas.getContext('2d');
  vCtx.scale(dpr, dpr);

  const CY  = H / 2;
  const sw  = parseFloat(stringLine.style.getPropertyValue('--sw')) || 2;

  // Visual oscillation rate: thicker strings appear to move slower
  const vizHz   = 5 + stringIdx * 0.6;   // 5 Hz (E2) … 8 Hz (E4)
  const vibMs   = 2800;                   // total animation duration
  const startT  = performance.now();

  // Show canvas, hide static line
  vibeCanvas.style.display = 'block';
  stringLine.style.opacity = '0';

  function frame(now) {
    const elapsed = now - startT;
    const t       = Math.min(elapsed / vibMs, 1);

    if (t >= 1) {
      // Vibration done — restore static string
      vCtx.clearRect(0, 0, W, H);
      vibeCanvas.style.display = 'none';
      stringLine.style.opacity = '1';
      activeVibrations.delete(stringIdx);
      return;
    }

    // Exponential amplitude decay
    const decay    = Math.exp(-4.5 * t);
    const maxAmp   = Math.max(sw * 0.5, H * 0.34 * decay);
    const tSec     = elapsed / 1000;

    vCtx.clearRect(0, 0, W, H);

    // ── Draw standing wave with 3 harmonics ──────────────
    // y(x,t) = Σ Aₙ · sin(n·π·x) · cos(n·ω·t) · decayₙ
    // x is normalised 0→1, ends fixed at 0 and 1
    vCtx.beginPath();
    for (let px = 0; px <= W; px++) {
      const x = px / W;

      // Fundamental + 2nd + 3rd harmonic (each decays faster)
      const h1 = Math.sin(Math.PI * x)     * Math.cos(2 * Math.PI * vizHz * tSec);
      const h2 = Math.sin(2 * Math.PI * x) * Math.cos(4 * Math.PI * vizHz * tSec)
                 * Math.exp(-1.2 * t);
      const h3 = Math.sin(3 * Math.PI * x) * Math.cos(6 * Math.PI * vizHz * tSec)
                 * Math.exp(-2.5 * t);

      const dy = (h1 + h2 * 0.35 + h3 * 0.12) * maxAmp;

      if (px === 0) vCtx.moveTo(0,  CY + dy);
      else          vCtx.lineTo(px, CY + dy);
    }

    // String glow: opacity follows amplitude
    const alpha = 0.6 + 0.4 * decay;
    vCtx.strokeStyle    = `rgba(232, 216, 176, ${alpha})`;
    vCtx.lineWidth      = sw;
    vCtx.lineCap        = 'round';
    vCtx.shadowColor    = `rgba(240, 220, 160, ${alpha * 0.55})`;
    vCtx.shadowBlur     = sw * 3.5;
    vCtx.stroke();
    vCtx.shadowBlur     = 0;

    const raf = requestAnimationFrame(frame);
    activeVibrations.set(stringIdx, raf);
  }

  const raf = requestAnimationFrame(frame);
  activeVibrations.set(stringIdx, raf);
}

/** Stop all running vibration animations (e.g. on resize) */
function stopAllVibrations() {
  activeVibrations.forEach(raf => cancelAnimationFrame(raf));
  activeVibrations.clear();
  document.querySelectorAll('.string-vibe-canvas').forEach(c => {
    c.style.display = 'none';
  });
  document.querySelectorAll('.string-line').forEach(l => {
    l.style.opacity = '1';
  });
}

// ═══════════════════════════════════════════════════════
//  CANVAS RESIZE
// ═══════════════════════════════════════════════════════
function resizeCanvases() {
  const dpr  = window.devicePixelRatio || 1;

  // ── Meter ──
  const mb   = document.getElementById('meter-bg');
  const mr   = mb.getBoundingClientRect();
  meterCanvas.width  = Math.round(mr.width  * dpr);
  meterCanvas.height = Math.round(mr.height * dpr);
  meterCanvas.style.width  = mr.width  + 'px';
  meterCanvas.style.height = mr.height + 'px';
  // Draw will happen in the RAF loop; do one immediate draw
  mCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawMeter(needleAngle);

  // ── Fretboard ──
  const sc   = document.getElementById('strings-container');
  const sr   = sc.getBoundingClientRect();
  fretCanvas.width  = Math.round(sr.width  * dpr);
  fretCanvas.height = Math.round(sr.height * dpr);
  fretCanvas.style.width  = sr.width  + 'px';
  fretCanvas.style.height = sr.height + 'px';
  drawFretboardBg();
}

// ═══════════════════════════════════════════════════════
//  METER DIAL DRAWING
// ═══════════════════════════════════════════════════════
function drawMeter(angleDeg) {
  const dpr = window.devicePixelRatio || 1;
  const W   = meterCanvas.width  / dpr;   // CSS pixels
  const H   = meterCanvas.height / dpr;

  mCtx.clearRect(0, 0, W, H);

  // ── Pivot: aligned with the 82px indicator light centre (bottom: 26px + 41px = 67px from bottom) ──
  const cx  = W / 2;
  const cy  = H - 67;
  const R   = Math.min(W * 0.46, cy - 8);

  // ── EXACT SEMICIRCLE: from 180° (Math.PI) to 360° (2*Math.PI) ──
  const startA = Math.PI * 1.0;   // 180° (horizontal left base)
  const endA   = Math.PI * 2.0;   // 360° / 0° (horizontal right base)
  const span   = Math.PI;         // 180° sweep

  // ── Cream dial face (Semicircle with flat horizontal bottom) ──
  mCtx.beginPath();
  mCtx.moveTo(cx - R, cy);
  mCtx.arc(cx, cy, R, startA, endA, false);
  mCtx.lineTo(cx + R, cy);
  mCtx.closePath();

  const grad = mCtx.createRadialGradient(cx, cy - R * 0.35, R * 0.05, cx, cy, R);
  grad.addColorStop(0,    '#fcf4e0');
  grad.addColorStop(0.55, '#f4e5c3');
  grad.addColorStop(1,    '#ceb88a');
  mCtx.fillStyle = grad;
  mCtx.fill();

  // Outer border arc & flat bottom base
  mCtx.beginPath();
  mCtx.arc(cx, cy, R, startA, endA);
  mCtx.strokeStyle = '#8a7050';
  mCtx.lineWidth   = 2.5;
  mCtx.stroke();

  mCtx.beginPath();
  mCtx.moveTo(cx - R, cy);
  mCtx.lineTo(cx + R, cy);
  mCtx.strokeStyle = '#8a7050';
  mCtx.lineWidth   = 1.5;
  mCtx.stroke();

  // ── Green central tuning sector / wedge (±5 cents, translucent) ──
  const zH = (IN_TUNE_CENTS / 100) * span;
  const cA  = startA + 0.5 * span; // 1.5 * Math.PI (top vertical 270°)
  mCtx.beginPath();
  mCtx.moveTo(cx, cy);
  mCtx.arc(cx, cy, R * 0.96, cA - zH, cA + zH);
  mCtx.closePath();
  mCtx.fillStyle = 'rgba(70, 180, 70, 0.22)';
  mCtx.fill();

  // ── Scale ticks & labels ─────────────────────────────
  for (let v = -50; v <= 50; v += 5) {
    const major = (v % 10 === 0);
    const norm  = (v + 50) / 100;
    const angle = startA + norm * span;
    const cos   = Math.cos(angle);
    const sin   = Math.sin(angle);

    const r1 = R * (major ? 0.78 : 0.86);
    const r2 = R * 0.94;

    mCtx.beginPath();
    mCtx.moveTo(cx + cos * r1, cy + sin * r1);
    mCtx.lineTo(cx + cos * r2, cy + sin * r2);
    mCtx.strokeStyle = major ? '#382e22' : '#8c7d6b';
    mCtx.lineWidth   = major ? 2.2 : 1.2;
    mCtx.stroke();

    if (major) {
      const rL  = R * 0.67;
      const txt = v === 0 ? '0' : (v > 0 ? `+${v}` : `${v}`);
      mCtx.font         = `bold ${Math.max(10, Math.round(R * 0.055))}px Arial`;
      mCtx.fillStyle    = '#2e261e';
      mCtx.textAlign    = 'center';
      mCtx.textBaseline = 'middle';
      mCtx.fillText(txt, cx + cos * rL, cy + sin * rL);
    }
  }

  // "cent" label (bottom-left)
  mCtx.font         = `italic ${Math.max(9, Math.round(R * 0.046))}px Georgia`;
  mCtx.fillStyle    = '#6b5842';
  mCtx.textAlign    = 'left';
  mCtx.textBaseline = 'alphabetic';
  mCtx.fillText('cent', cx - R * 0.88, cy + 18);

  // Watermark text
  mCtx.save();
  mCtx.font      = `italic bold ${Math.round(R * 0.075)}px Georgia`;
  mCtx.fillStyle = 'rgba(120,80,40,0.12)';
  mCtx.textAlign = 'center';
  mCtx.textBaseline = 'middle';
  mCtx.translate(cx, cy - R * 0.44);
  mCtx.rotate(-0.08);
  mCtx.fillText('Afinador Pro', 0, 0);
  mCtx.restore();

  // ── Needle ───────────────────────────────────────────
  const nAngle = startA + ((angleDeg + 50) / 100) * span;
  const nLen   = R * 0.94;
  const nCos   = Math.cos(nAngle);
  const nSin   = Math.sin(nAngle);

  mCtx.save();
  mCtx.shadowColor   = 'rgba(0,0,0,0.4)';
  mCtx.shadowBlur    = 5;
  mCtx.shadowOffsetX = 2;
  mCtx.shadowOffsetY = 2;

  mCtx.beginPath();
  mCtx.moveTo(cx, cy);
  mCtx.lineTo(cx + nCos * nLen, cy + nSin * nLen);
  mCtx.strokeStyle = '#140c0c';
  mCtx.lineWidth   = 2.6;
  mCtx.lineCap     = 'round';
  mCtx.stroke();
  mCtx.restore();

  // Pivot dot
  mCtx.beginPath();
  mCtx.arc(cx, cy, 6.5, 0, Math.PI * 2);
  const pivGrad = mCtx.createRadialGradient(cx - 2, cy - 2, 1, cx, cy, 6.5);
  pivGrad.addColorStop(0, '#666');
  pivGrad.addColorStop(1, '#111');
  mCtx.fillStyle = pivGrad;
  mCtx.fill();
}

// ═══════════════════════════════════════════════════════
//  FRETBOARD BACKGROUND DRAWING
// ═══════════════════════════════════════════════════════
function drawFretboardBg() {
  const dpr = window.devicePixelRatio || 1;

  // Always reset transform to avoid accumulation
  fCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = fretCanvas.width  / dpr;
  const H = fretCanvas.height / dpr;
  fCtx.clearRect(0, 0, W, H);

  const pegW     = 72;          // must match .string-peg width
  const numFrets = 5;
  const fretW    = (W - pegW) / numFrets;

  // ── Peg column background ──
  fCtx.fillStyle = '#140a04';
  fCtx.fillRect(0, 0, pegW, H);

  // ── Wood grain for the neck ──
  const woodGrad = fCtx.createLinearGradient(pegW, 0, W, 0);
  woodGrad.addColorStop(0,    '#2e1a0a');
  woodGrad.addColorStop(0.25, '#3d2612');
  woodGrad.addColorStop(0.6,  '#2b1a0a');
  woodGrad.addColorStop(1,    '#1e1208');
  fCtx.fillStyle = woodGrad;
  fCtx.fillRect(pegW, 0, W - pegW, H);

  // ── Subtle wood grain stripes (horizontal) ──
  for (let y = 0; y < H; y += 18) {
    fCtx.beginPath();
    fCtx.moveTo(pegW, y);
    fCtx.lineTo(W, y);
    fCtx.strokeStyle = 'rgba(255,200,120,0.025)';
    fCtx.lineWidth = 8;
    fCtx.stroke();
  }

  // ── Fret lines — ivory/silver, NO red ──
  for (let f = 0; f <= numFrets; f++) {
    const x = pegW + f * fretW;

    if (f === 0) {
      // Nut: wider, ivory coloured
      const nutGrad = fCtx.createLinearGradient(x - 4, 0, x + 4, 0);
      nutGrad.addColorStop(0,   '#a09070');
      nutGrad.addColorStop(0.4, '#e8dcc0');
      nutGrad.addColorStop(1,   '#907850');
      fCtx.fillStyle = nutGrad;
      fCtx.fillRect(x - 4, 0, 7, H);
    } else {
      // Regular fret: thin silver/ivory line
      const fGrad = fCtx.createLinearGradient(x - 1, 0, x + 2, 0);
      fGrad.addColorStop(0,   'rgba(160,145,110,0.6)');
      fGrad.addColorStop(0.5, 'rgba(220,205,165,0.85)');
      fGrad.addColorStop(1,   'rgba(140,125,90,0.5)');
      fCtx.fillStyle = fGrad;
      fCtx.fillRect(x - 1, 0, 2.5, H);
    }
  }

  // ── Fret position inlay dots (3rd and 5th fret positions) ──
  [2, 4].forEach(f => {
    const x = pegW + (f - 0.5) * fretW;
    const y = H / 2;

    fCtx.beginPath();
    fCtx.arc(x, y, 7, 0, Math.PI * 2);
    fCtx.fillStyle = 'rgba(210,190,140,0.15)';
    fCtx.fill();
    fCtx.strokeStyle = 'rgba(210,190,140,0.3)';
    fCtx.lineWidth = 1;
    fCtx.stroke();
  });
}

// ═══════════════════════════════════════════════════════
//  PITCH DETECTION — autocorrelation
// ═══════════════════════════════════════════════════════
function detectPitch(buf, sampleRate) {
  const SIZE  = buf.length;
  const HALF  = Math.floor(SIZE / 2);

  // RMS silence check
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.008) return null;

  // Autocorrelation
  const corr = new Float32Array(HALF);
  for (let lag = 0; lag < HALF; lag++) {
    let s = 0;
    for (let i = 0; i < HALF; i++) s += buf[i] * buf[i + lag];
    corr[lag] = s;
  }

  // Find first trough then highest peak
  let d = 1;
  while (d < HALF && corr[d] > corr[d - 1]) d++;
  let maxV = -Infinity, maxP = -1;
  for (let i = d; i < HALF; i++) {
    if (corr[i] > maxV) { maxV = corr[i]; maxP = i; }
  }
  if (maxP === -1 || maxV / corr[0] < MIN_CONF) return null;

  // Parabolic interpolation for sub-sample accuracy
  const y1  = corr[maxP - 1] ?? corr[maxP];
  const y2  = corr[maxP];
  const y3  = corr[maxP + 1] ?? corr[maxP];
  const denom = 2 * (2 * y2 - y1 - y3);
  const shift = denom !== 0 ? (y3 - y1) / denom : 0;
  return sampleRate / (maxP + shift);
}

// ── Freq → note ──────────────────────────────────────
function freqToNote(freq) {
  if (!freq || freq <= 0) return null;
  const midiF   = 12 * Math.log2(freq / A4_FREQ) + A4_MIDI;
  const midiR   = Math.round(midiF);
  const cents   = (midiF - midiR) * 100;
  const noteIdx = ((midiR % 12) + 12) % 12;
  const octave  = Math.floor(midiR / 12) - 1;
  return { note: NOTES[noteIdx], octave, cents, freq };
}

// ═══════════════════════════════════════════════════════
//  AUDIO SETUP
// ═══════════════════════════════════════════════════════
async function startTuner() {
  const overlay = document.getElementById('mic-overlay');
  if (overlay) overlay.remove();

  try {
    ensureAudioCtx();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.3;

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    sourceNode   = audioCtx.createMediaStreamSource(stream);
    sourceNode.connect(analyser);

    timeDomainBuf = new Float32Array(analyser.fftSize);
    isRunning     = true;
    loop();
  } catch (err) {
    alert('No se pudo acceder al micrófono: ' + err.message);
    showMicOverlay();
  }
}

// ═══════════════════════════════════════════════════════
//  MAIN ANIMATION / DETECTION LOOP
// ═══════════════════════════════════════════════════════

// Cents smoothing factor: smaller = slower/smoother needle
const SMOOTH = 0.07;

/** Return the most-voted {note,octave} from noteHistory, or null */
function getStableNote() {
  if (noteHistory.length < 4) return null;
  const votes = {};
  noteHistory.forEach(h => {
    const key = `${h.note}|${h.octave}`;
    votes[key] = (votes[key] || 0) + 1;
  });
  const [topKey, topCount] = Object.entries(votes)
    .sort((a, b) => b[1] - a[1])[0];
  // Require at least 55% consensus before committing
  if (topCount / noteHistory.length < 0.55) return null;
  const [note, octStr] = topKey.split('|');
  return { note, octave: parseInt(octStr) };
}

let displayFreq = 440.0;

function loop() {
  if (!isRunning) return;
  animFrame = requestAnimationFrame(loop);

  const dpr = window.devicePixelRatio || 1;

  // ── Pitch detection ──
  if (analyser) {
    analyser.getFloatTimeDomainData(timeDomainBuf);
    const freq     = detectPitch(timeDomainBuf, audioCtx.sampleRate);
    const detected = freqToNote(freq);

    if (detected) {
      let { note, octave, cents, freq: detFreq } = detected;

      if (lockedString !== null) {
        // Compute cents relative to the locked string's exact frequency
        const target  = GUITAR_STRINGS[lockedString];
        const tMidi   = 12 * Math.log2(target.freq / A4_FREQ) + A4_MIDI;
        const dMidi   = 12 * Math.log2(detected.freq / A4_FREQ) + A4_MIDI;
        cents         = Math.max(-50, Math.min(50, (dMidi - tMidi) * 100));
        note          = target.note.replace(/\d/, '');
        octave        = target.octave;
        detFreq       = target.freq;
      }

      // Push into history buffer for stability voting
      noteHistory.push({ note, octave });
      if (noteHistory.length > NOTE_HIST_SIZE) noteHistory.shift();

      // Smooth the cents deviation continuously
      displayCents = displayCents + SMOOTH * (cents - displayCents);
      targetAngle  = Math.max(-50, Math.min(50, displayCents));
      displayFreq  = detFreq;

      // Only commit a new note when history votes agree
      const stable = getStableNote();
      if (stable) {
        displayNote   = stable.note;
        displayOctave = stable.octave;
      }
    } else {
      // Silence → drift back towards 0
      displayCents  *= 0.92;
      targetAngle    = displayCents;
      noteHistory    = [];   // reset history on silence
    }
  }

  // ── Needle — very smooth interpolation (0.05 = slow) ──
  needleAngle += (targetAngle - needleAngle) * 0.05;

  // ── Redraw meter ──
  mCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawMeter(needleAngle);

  // ── Update wheel & circle ──
  if (isRunning) updateNoteWheel(displayNote || 'E', displayCents, displayOctave, displayFreq);
}

// ═══════════════════════════════════════════════════════
//  NAV BAR
// ═══════════════════════════════════════════════════════
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Nav-settings button also opens the modal
    if (btn.id === 'nav-settings') openSettingsModal();
  });
});

// ═══════════════════════════════════════════════════════
//  SETTINGS MODAL
// ═══════════════════════════════════════════════════════
const settingsOverlay = document.getElementById('settings-overlay');
const wakeLockToggle  = document.getElementById('wake-lock-toggle');
const wakeLockStatus  = document.getElementById('wake-lock-status');
const wakeLockIcon    = document.getElementById('wake-lock-icon');
const wakeLockText    = document.getElementById('wake-lock-text');

function openSettingsModal() {
  settingsOverlay.classList.remove('modal-hidden');
}

function closeSettingsModal() {
  settingsOverlay.classList.add('modal-hidden');
}

// Open via ⚙ button in the note-wheel section
document.getElementById('settings-btn').addEventListener('click', openSettingsModal);

// Close via ✕ button
document.getElementById('settings-close').addEventListener('click', closeSettingsModal);

// Close when clicking the dark backdrop (outside the modal card)
settingsOverlay.addEventListener('click', e => {
  if (e.target === settingsOverlay) closeSettingsModal();
});

// Close on Escape key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSettingsModal();
});

// ═══════════════════════════════════════════════════════
//  WAKE LOCK  (Screen Wake Lock API)
// ═══════════════════════════════════════════════════════
let wakeLockSentinel = null;    // holds the active WakeLockSentinel
const WAKE_LOCK_SUPPORTED = ('wakeLock' in navigator);

/** Update the status badge inside the modal */
function updateWakeLockBadge(state) {
  // state: 'on' | 'off' | 'unsupported'
  wakeLockStatus.className = `status-${state}`;

  if (state === 'on') {
    wakeLockIcon.textContent = '🟢';
    wakeLockText.textContent = 'Pantalla siempre encendida activa';
  } else if (state === 'off') {
    wakeLockIcon.textContent = '🔴';
    wakeLockText.textContent = 'La pantalla puede apagarse';
  } else {
    wakeLockIcon.textContent = '⚠️';
    wakeLockText.textContent = 'Wake Lock no soportado en este navegador';
  }
}

/** Request the wake lock */
async function acquireWakeLock() {
  if (!WAKE_LOCK_SUPPORTED) {
    updateWakeLockBadge('unsupported');
    wakeLockToggle.checked = false;
    return;
  }
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');

    // If the OS releases it (e.g., tab goes to background), update UI
    wakeLockSentinel.addEventListener('release', () => {
      wakeLockSentinel = null;
      if (wakeLockToggle.checked) {
        // Tab is visible again — try to re-acquire
        if (!document.hidden) acquireWakeLock();
      } else {
        updateWakeLockBadge('off');
      }
    });

    updateWakeLockBadge('on');
  } catch (err) {
    console.warn('Wake Lock request failed:', err.message);
    wakeLockToggle.checked = false;
    updateWakeLockBadge('off');
  }
}

/** Release the wake lock */
async function releaseWakeLock() {
  if (wakeLockSentinel) {
    await wakeLockSentinel.release();
    wakeLockSentinel = null;
  }
  updateWakeLockBadge('off');
}

// Wire toggle switch
wakeLockToggle.addEventListener('change', () => {
  if (wakeLockToggle.checked) {
    acquireWakeLock();
  } else {
    releaseWakeLock();
  }
});

// Re-acquire when the tab becomes visible again (browser releases it on hide)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && wakeLockToggle.checked && !wakeLockSentinel) {
    acquireWakeLock();
  }
});

// Set initial badge state
if (!WAKE_LOCK_SUPPORTED) {
  updateWakeLockBadge('unsupported');
  wakeLockToggle.disabled = true;
} else {
  updateWakeLockBadge('off');
}

// ═══════════════════════════════════════════════════════
//  STRING VIBRATION SETTING
// ═══════════════════════════════════════════════════════
const vibrationToggle = document.getElementById('vibration-toggle');

vibrationToggle.addEventListener('change', () => {
  vibrationEnabled = vibrationToggle.checked;
  if (!vibrationEnabled) {
    // Stop any currently running vibrations immediately
    stopAllVibrations();
  }
});

// ═══════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════

// Stop vibrations on resize to avoid stale canvas dimensions
window.addEventListener('resize', stopAllVibrations);

window.addEventListener('DOMContentLoaded', init);
