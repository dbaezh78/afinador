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
//  STATE
// ═══════════════════════════════════════════════════════
let audioCtx = null;
let analyser, sourceNode, timeDomainBuf;
let isRunning    = false;
let lockedString = null;
let animFrame;

let displayCents  = 0;
let displayNote   = 'E';
let needleAngle   = 0;
let targetAngle   = 0;

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

function updateNoteWheel(note, cents) {
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
      // else remains dim
    });
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
      <div class="string-line" style="--sw:${sw}px"></div>
    `;

    row.addEventListener('click', () => handleStringTap(origIdx, row));
    stringsList.appendChild(row);
  });
}

function handleStringTap(idx, rowEl) {
  // Play the string's note
  playKarplusStrong(GUITAR_STRINGS[idx].freq);

  // Toggle lock
  document.querySelectorAll('.string-row').forEach(r => r.classList.remove('active'));
  if (lockedString === idx) {
    lockedString = null;
  } else {
    lockedString = idx;
    rowEl.classList.add('active');
    // Snap wheel to that string's note
    const s = GUITAR_STRINGS[idx];
    const noteName = s.note.replace(/\d/, ''); // strip octave number
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

// ── Karplus-Strong plucked string synthesis ──────────
function playKarplusStrong(freq, duration = 3.0) {
  ensureAudioCtx();

  const sr         = audioCtx.sampleRate;
  const period     = Math.round(sr / freq);
  const totalSamps = Math.round(sr * duration);

  const offBuf = audioCtx.createBuffer(1, totalSamps, sr);
  const data   = offBuf.getChannelData(0);

  // Initialise ring buffer with white noise
  const ring = new Float32Array(period);
  for (let i = 0; i < period; i++) ring[i] = Math.random() * 2 - 1;

  // Karplus-Strong averaging filter
  for (let i = 0; i < totalSamps; i++) {
    const idx0 = i       % period;
    const idx1 = (i + 1) % period;
    ring[idx0] = 0.498 * (ring[idx0] + ring[idx1]);
    data[i]    = ring[idx0];
  }

  const src  = audioCtx.createBufferSource();
  src.buffer = offBuf;

  // Gentle volume envelope so it doesn't clip
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.75, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);

  // Light low-pass to soften harshness
  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = Math.min(freq * 8, 6000);
  lp.Q.value = 0.5;

  src.connect(lp);
  lp.connect(gain);
  gain.connect(audioCtx.destination);
  src.start();
  src.stop(audioCtx.currentTime + duration);
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

  // ── Pivot point: bottom-centre of canvas minus 35px (indicator half-height)
  //    so the needle visually emerges from the indicator light centre ──
  const cx  = W / 2;
  const cy  = H - 35;                               // aligns with #indicator-light centre
  const R   = Math.min(W * 0.47, cy - 8);           // radius: just fits in canvas height

  const startA = Math.PI * 1.15;   // ~207° (left end of scale)
  const endA   = Math.PI * 1.85;   // ~333° (right end of scale)
  const span   = endA - startA;

  // ── Cream dial face (pie slice) ──────────────────────
  mCtx.beginPath();
  mCtx.moveTo(cx, cy);
  mCtx.arc(cx, cy, R * 1.01, startA, endA);
  mCtx.closePath();
  const grad = mCtx.createRadialGradient(cx, cy - R * 0.35, R * 0.05, cx, cy, R);
  grad.addColorStop(0,    '#f8edd4');
  grad.addColorStop(0.55, '#ecdbb5');
  grad.addColorStop(1,    '#c8b48a');
  mCtx.fillStyle = grad;
  mCtx.fill();

  // Outer border arc
  mCtx.beginPath();
  mCtx.arc(cx, cy, R, startA, endA);
  mCtx.strokeStyle = '#8a7050';
  mCtx.lineWidth   = 2.5;
  mCtx.stroke();

  // ── Scale ticks & labels ─────────────────────────────
  for (let v = -50; v <= 50; v += 5) {
    const major = (v % 10 === 0);
    const norm  = (v + 50) / 100;
    const angle = startA + norm * span;
    const cos   = Math.cos(angle);
    const sin   = Math.sin(angle);

    const r1 = R * (major ? 0.80 : 0.87);
    const r2 = R * 0.93;

    mCtx.beginPath();
    mCtx.moveTo(cx + cos * r1, cy + sin * r1);
    mCtx.lineTo(cx + cos * r2, cy + sin * r2);
    mCtx.strokeStyle = major ? '#555' : '#999';
    mCtx.lineWidth   = major ? 2 : 1;
    mCtx.stroke();

    if (major) {
      const rL  = R * 0.72;
      const txt = v === 0 ? '0' : (v > 0 ? `+${v}` : `${v}`);
      mCtx.font         = `bold ${Math.max(9, Math.round(R * 0.048))}px Arial`;
      mCtx.fillStyle    = '#333';
      mCtx.textAlign    = 'center';
      mCtx.textBaseline = 'middle';
      mCtx.fillText(txt, cx + cos * rL, cy + sin * rL);
    }
  }

  // "cent" label (bottom-left)
  mCtx.font         = `italic ${Math.max(8, Math.round(R * 0.042))}px Georgia`;
  mCtx.fillStyle    = '#777';
  mCtx.textAlign    = 'left';
  mCtx.textBaseline = 'alphabetic';
  mCtx.fillText('cent', cx - R * 0.9, cy - R * 0.05);

  // Watermark
  mCtx.save();
  mCtx.font      = `italic bold ${Math.round(R * 0.07)}px Georgia`;
  mCtx.fillStyle = 'rgba(120,80,40,0.15)';
  mCtx.textAlign = 'center';
  mCtx.textBaseline = 'middle';
  mCtx.translate(cx, cy - R * 0.44);
  mCtx.rotate(-0.14);
  mCtx.fillText('Afinador Pro', 0, 0);
  mCtx.restore();

  // Green centre zone highlight
  const zH = (IN_TUNE_CENTS / 100) * span;
  const cA  = startA + 0.5 * span;
  mCtx.beginPath();
  mCtx.moveTo(cx, cy);
  mCtx.arc(cx, cy, R * 0.94, cA - zH, cA + zH);
  mCtx.closePath();
  mCtx.fillStyle = 'rgba(0, 200, 80, 0.08)';
  mCtx.fill();

  // ── Needle ───────────────────────────────────────────
  const nAngle = startA + ((angleDeg + 50) / 100) * span;
  const nLen   = R * 0.90;
  const nCos   = Math.cos(nAngle);
  const nSin   = Math.sin(nAngle);

  mCtx.save();
  mCtx.shadowColor   = 'rgba(0,0,0,0.3)';
  mCtx.shadowBlur    = 5;
  mCtx.shadowOffsetX = 2;
  mCtx.shadowOffsetY = 2;

  mCtx.beginPath();
  mCtx.moveTo(cx, cy);
  mCtx.lineTo(cx + nCos * nLen, cy + nSin * nLen);
  mCtx.strokeStyle = '#111';
  mCtx.lineWidth   = 2.5;
  mCtx.lineCap     = 'round';
  mCtx.stroke();
  mCtx.restore();

  // Pivot dot (drawn on top so it hides needle base)
  mCtx.beginPath();
  mCtx.arc(cx, cy, 6, 0, Math.PI * 2);
  const pivGrad = mCtx.createRadialGradient(cx - 2, cy - 2, 1, cx, cy, 6);
  pivGrad.addColorStop(0, '#555');
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
const SMOOTH = 0.22;

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
      let { note, cents } = detected;

      if (lockedString !== null) {
        // Compute cents relative to the locked string
        const target      = GUITAR_STRINGS[lockedString];
        const tMidi       = 12 * Math.log2(target.freq / A4_FREQ) + A4_MIDI;
        const dMidi       = 12 * Math.log2(detected.freq / A4_FREQ) + A4_MIDI;
        cents             = Math.max(-50, Math.min(50, (dMidi - tMidi) * 100));
        note              = target.note.replace(/\d/, '');
      }

      displayCents = displayCents + SMOOTH * (cents - displayCents);
      displayNote  = note;
      targetAngle  = Math.max(-50, Math.min(50, displayCents));
    } else {
      displayCents *= 0.94;
      targetAngle   = displayCents;
    }
  }

  // ── Needle interpolation ──
  needleAngle += (targetAngle - needleAngle) * 0.12;

  // ── Redraw meter ──
  mCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawMeter(needleAngle);

  // ── Update wheel (only when note is active) ──
  if (isRunning) updateNoteWheel(displayNote || 'E', displayCents);
}

// ═══════════════════════════════════════════════════════
//  NAV BAR
// ═══════════════════════════════════════════════════════
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// ═══════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', init);
