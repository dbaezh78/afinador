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
const FFT_SIZE       = 2048; // Exactly matches gtuner BUF_SIZE for optimal time-frequency resolution
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
  updateNoteWheel('E', 0, 4, 329.6);
  showMicOverlay();

  // Try to acquire wake lock by default (if supported and context allows)
  if (wakeLockToggle && wakeLockToggle.checked) {
    acquireWakeLock();
  }

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

function highlightDetectedString(note, octave, cents, freq = null) {
  const rows = document.querySelectorAll('.string-row');
  let matchedIdx = -1;

  // Best match by frequency proximity or note + octave
  if (freq && freq > 0) {
    let minDiff = Infinity;
    GUITAR_STRINGS.forEach((str, idx) => {
      // Half an octave range check (~40% frequency distance)
      const ratio = freq / str.freq;
      const diff = Math.abs(Math.log2(ratio));
      if (diff < 0.35 && diff < minDiff) {
        minDiff = diff;
        matchedIdx = idx;
      }
    });
  }

  // Fallback: match by note name and closest octave
  if (matchedIdx === -1) {
    let bestOctDiff = Infinity;
    GUITAR_STRINGS.forEach((str, idx) => {
      const sNote = str.note.replace(/\d/, '');
      if (sNote === note) {
        const octDiff = octave !== undefined ? Math.abs(str.octave - octave) : 0;
        if (octDiff < bestOctDiff) {
          bestOctDiff = octDiff;
          matchedIdx = idx;
        }
      }
    });
  }

  rows.forEach(r => {
    const idx = parseInt(r.dataset.idx);
    r.classList.remove('detected', 'detected-in-tune');
    if (idx === matchedIdx) {
      if (Math.abs(cents) <= IN_TUNE_CENTS) {
        r.classList.add('detected-in-tune');
      } else {
        r.classList.add('detected');
      }
    }
  });

  return matchedIdx;
}

let lastVibratedIdx = -1;
let lastVibratedTime = 0;

function updateNoteWheel(note, cents, octave = 4, frequency = null) {
  const baseIdx = NOTES.indexOf(note);
  if (baseIdx === -1) return;

  // Continuous wheel position: baseIdx in the middle copy (offset 12) + sub-note offset from cents
  const continuousIdx = 12 + baseIdx + (cents / 100);

  const wheelW     = noteWheelEl.offsetWidth;
  const translateX = wheelW / 2 - (continuousIdx + 0.5) * CELL_W;

  noteTrackEl.style.transform = `translateX(${translateX.toFixed(1)}px)`;

  const targetIdx = 12 + baseIdx;
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
  }

  // Update LCD display inside the indicator circle
  if (nicNote) nicNote.textContent = note;
  if (nicOct)  nicOct.textContent  = octave;

  // Highlight and trigger vibration on the matched guitar string
  const matchedIdx = highlightDetectedString(note, octave, cents, frequency);
  if (matchedIdx !== -1) {
    const now = performance.now();
    // If not vibrated recently (debounce 1.5s), trigger string wave vibration
    if (matchedIdx !== lastVibratedIdx || now - lastVibratedTime > 1600) {
      const targetRow = document.querySelector(`.string-row[data-idx="${matchedIdx}"]`);
      if (targetRow) {
        startStringVibration(matchedIdx, targetRow);
        lastVibratedIdx = matchedIdx;
        lastVibratedTime = now;
      }
    }
  }

  // Update frequency (Hz / exact tuning pitch) readout below circle: format as XXX.X (e.g. 82.4 or 440.0)
  if (freqValEl) {
    let hz = 0;
    if (frequency && frequency > 0 && frequency < 2000) {
      hz = frequency;
    } else if (NOTE_FREQS[note]) {
      const baseFreq = NOTE_FREQS[note];
      const octOffset = (octave >= 1 && octave <= 7 ? octave : 4) - 4;
      hz = baseFreq * Math.pow(2, octOffset);
    }
    if (hz > 0) {
      freqValEl.textContent = hz.toFixed(1);
    }
  }

  // Indicator light colour: turns emerald green when in tune
  const abs = Math.abs(cents);
  if (abs <= IN_TUNE_CENTS) {
    indicatorLight.className = 'light-green';
  } else if (abs <= CLOSE_CENTS) {
    indicatorLight.className = 'light-yellow';
  } else {
    indicatorLight.className = 'light-red';
  }
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
    // String number: 1 for Mi4 (thinnest), up to 6 for Mi2 (thickest)
    const stringNum = 6 - origIdx;
    const freqLabel = str.freq.toFixed(1);

    row.innerHTML = `
      <div class="string-peg">
        <span class="note-name">${str.name}</span><span class="octave">${str.octave}</span>
      </div>
      <div class="string-line-wrap">
        <span class="string-number">${stringNum} - &nbsp;${freqLabel}</span>
        <div class="string-line" style="--sw:${sw}px"></div>
        <canvas class="string-vibe-canvas"></canvas>
      </div>
    `;

    row.addEventListener('click', () => handleStringTap(origIdx, row));
    stringsList.appendChild(row);
  });
}

function handleStringTap(idx, rowEl) {
  const str = GUITAR_STRINGS[idx];
  const noteName = str.note.replace(/\d/, '');

  // 1. Play real guitar string pluck
  playKarplusStrong(str.freq, idx);

  // 2. Animate physical string vibration wave
  startStringVibration(idx, rowEl);

  // 3. Immediately update UI to this exact string chord / note, octave, and Hz
  displayNote   = noteName;
  displayOctave = str.octave;
  let displayFreq = str.freq;
  displayCents  = 0;
  targetAngle   = 0;
  needleAngle   = 0;

  // Redraw meter needle pointing to exact 0 (in-tune)
  const dpr = window.devicePixelRatio || 1;
  mCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawMeter(0);

  // Update note wheel and frequency display
  updateNoteWheel(noteName, 0, str.octave, displayFreq);

  // 4. Toggle string lock
  document.querySelectorAll('.string-row').forEach(r => r.classList.remove('active'));
  if (lockedString === idx) {
    lockedString = null;
  } else {
    lockedString = idx;
    rowEl.classList.add('active');
  }

  // Ensure wake lock is acquired on first interaction if enabled
  if (wakeLockToggle && wakeLockToggle.checked && !wakeLockSentinel) {
    acquireWakeLock();
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

/**
 * Play a synthetic harmonic chime when a string is perfectly in tune.
 * Matches gtuner's success bell tone.
 */
let isMuted = false;
let lastChimeTime = 0;

function playSuccessChime() {
  if (isMuted) return;
  ensureAudioCtx();
  if (!audioCtx) return;

  const now = performance.now();
  if (now - lastChimeTime < 900) return; // Prevent chime spamming
  lastChimeTime = now;

  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1760, audioCtx.currentTime + 0.15);

    gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start();
    osc.stop(audioCtx.currentTime + 0.25);
  } catch (e) {
    console.error('Error playing chime:', e);
  }
}

// ── Improved Karplus-Strong — guitar-optimised ────────
/**
 * Synthesises a plucked guitar string note using the Karplus-Strong algorithm.
 * Pluck excitation is filtered noise (bridge-proximity simulation).
 * Wound strings (E2, A2, D3) have longer decay and warmer filtering than plain (G3, B3, E4).
 *
 * @param {number} freq       - fundamental frequency in Hz
 * @param {number} stringIdx  - 0=E2 (thickest), 5=E4 (thinnest)
 */
function playKarplusStrong(freq, stringIdx) {
  ensureAudioCtx();

  const sr = audioCtx.sampleRate;
  const period = Math.round(sr / freq);
  if (period < 2) return;

  const isWound  = stringIdx < 3;
  const duration = isWound ? 3.5 : 2.0;
  const totalSamples = Math.floor(sr * duration);

  const buffer = audioCtx.createBuffer(1, totalSamples, sr);
  const data   = buffer.getChannelData(0);

  const noise = new Float32Array(period);
  let prevSample = 0;
  const pickFilterCoeff = isWound ? 0.35 : 0.65;
  for (let i = 0; i < period; i++) {
    const white = Math.random() * 2 - 1;
    prevSample  = prevSample + pickFilterCoeff * (white - prevSample);
    noise[i]    = prevSample;
  }

  for (let i = 0; i < period; i++) data[i] = noise[i];

  const damping = isWound ? 0.993 : 0.987;
  for (let i = period; i < totalSamples; i++) {
    data[i] = (data[i - period] + data[i - period + 1]) * 0.5 * damping;
  }

  const src = audioCtx.createBufferSource();
  src.buffer = buffer;

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0, audioCtx.currentTime);
  gain.gain.linearRampToValueAtTime(0.85, audioCtx.currentTime + 0.003);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);

  const lp = audioCtx.createBiquadFilter();
  lp.type            = 'lowpass';
  lp.frequency.value = isWound ? Math.min(freq * 12, 8000) : Math.min(freq * 9, 6500);
  lp.Q.value         = 0.8;

  const body = audioCtx.createBiquadFilter();
  body.type            = 'peaking';
  body.frequency.value = isWound ? 250 + stringIdx * 40 : 600 + stringIdx * 80;
  body.gain.value      = isWound ? 4 : 2.5;
  body.Q.value         = 1.8;

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

  if (activeVibrations.has(stringIdx)) {
    cancelAnimationFrame(activeVibrations.get(stringIdx));
    activeVibrations.delete(stringIdx);
  }

  const vibeCanvas = rowEl.querySelector('.string-vibe-canvas');
  const stringLine = rowEl.querySelector('.string-line');
  if (!vibeCanvas || !stringLine) return;

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

  const vizHz   = 5 + stringIdx * 0.6;
  const vibMs   = 2800;
  const startT  = performance.now();

  const maxAmp  = Math.min(H * 0.42, 6 + (5 - stringIdx) * 1.8);

  stringLine.style.opacity = '0';
  vibeCanvas.style.display = 'block';

  function drawWave(now) {
    const elapsed = now - startT;
    if (elapsed >= vibMs || !vibrationEnabled) {
      stopVibration(stringIdx, vibeCanvas, stringLine);
      return;
    }

    const decay1 = Math.exp(-elapsed / 900);
    const decay2 = Math.exp(-elapsed / 600);
    const decay3 = Math.exp(-elapsed / 400);

    const t   = elapsed / 1000;
    const w1  = 2 * Math.PI * vizHz;
    const w2  = 2 * Math.PI * (vizHz * 2.02);
    const w3  = 2 * Math.PI * (vizHz * 3.01);

    const c1 = Math.cos(w1 * t) * decay1;
    const c2 = Math.cos(w2 * t) * decay2 * 0.35;
    const c3 = Math.cos(w3 * t) * decay3 * 0.12;

    vCtx.clearRect(0, 0, W, H);

    vCtx.save();
    vCtx.shadowColor   = `rgba(255, 230, 140, ${(decay1 * 0.7).toFixed(2)})`;
    vCtx.shadowBlur    = Math.round(decay1 * 8);

    vCtx.beginPath();
    const steps = Math.min(120, Math.round(W / 2));
    for (let s = 0; s <= steps; s++) {
      const xNorm = s / steps;
      const x     = xNorm * W;

      const shape1 = Math.sin(Math.PI * xNorm);
      const shape2 = Math.sin(2 * Math.PI * xNorm);
      const shape3 = Math.sin(3 * Math.PI * xNorm);

      const yDisp = (shape1 * c1 + shape2 * c2 + shape3 * c3) * maxAmp;
      const y     = CY + yDisp;

      if (s === 0) vCtx.moveTo(x, y);
      else         vCtx.lineTo(x, y);
    }

    const strGrad = vCtx.createLinearGradient(0, 0, W, 0);
    strGrad.addColorStop(0,   '#b09878');
    strGrad.addColorStop(0.25,'#f5e8c8');
    strGrad.addColorStop(0.6, '#d8c8a0');
    strGrad.addColorStop(1,   '#907848');

    vCtx.strokeStyle = strGrad;
    vCtx.lineWidth   = sw;
    vCtx.lineCap     = 'round';
    vCtx.stroke();
    vCtx.restore();

    const handle = requestAnimationFrame(drawWave);
    activeVibrations.set(stringIdx, handle);
  }

  const handle = requestAnimationFrame(drawWave);
  activeVibrations.set(stringIdx, handle);
}

function stopVibration(stringIdx, vibeCanvas, stringLine) {
  if (activeVibrations.has(stringIdx)) {
    cancelAnimationFrame(activeVibrations.get(stringIdx));
    activeVibrations.delete(stringIdx);
  }
  if (vibeCanvas) {
    const vCtx = vibeCanvas.getContext('2d');
    vCtx.clearRect(0, 0, vibeCanvas.width, vibeCanvas.height);
    vibeCanvas.style.display = 'none';
  }
  if (stringLine) {
    stringLine.style.opacity = '1';
  }
}

function stopAllVibrations() {
  activeVibrations.forEach((handle, idx) => {
    cancelAnimationFrame(handle);
    const rowEl = document.querySelector(`.string-row[data-idx="${idx}"]`);
    if (rowEl) {
      const vibeCanvas = rowEl.querySelector('.string-vibe-canvas');
      const stringLine = rowEl.querySelector('.string-line');
      stopVibration(idx, vibeCanvas, stringLine);
    }
  });
  activeVibrations.clear();
}

// ═══════════════════════════════════════════════════════
//  RESIZE CANVASES
// ═══════════════════════════════════════════════════════
function resizeCanvases() {
  const dpr = window.devicePixelRatio || 1;

  const mr = meterCanvas.parentElement.getBoundingClientRect();
  meterCanvas.width  = Math.round(mr.width  * dpr);
  meterCanvas.height = Math.round(mr.height * dpr);
  meterCanvas.style.width  = mr.width  + 'px';
  meterCanvas.style.height = mr.height + 'px';
  mCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawMeter(needleAngle);

  const sc = document.getElementById('strings-container');
  const sr = sc.getBoundingClientRect();
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
  const W   = meterCanvas.width  / dpr;
  const H   = meterCanvas.height / dpr;

  mCtx.clearRect(0, 0, W, H);

  const cx  = W / 2;
  const cy  = H - 67;
  const R   = Math.min(W * 0.46, cy - 8);

  const startA = Math.PI * 1.0;
  const endA   = Math.PI * 2.0;
  const span   = Math.PI;

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

  const zH = (IN_TUNE_CENTS / 100) * span;
  const cA  = startA + 0.5 * span;
  mCtx.beginPath();
  mCtx.moveTo(cx, cy);
  mCtx.arc(cx, cy, R * 0.96, cA - zH, cA + zH);
  mCtx.closePath();
  mCtx.fillStyle = 'rgba(70, 180, 70, 0.22)';
  mCtx.fill();

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

  mCtx.font         = `italic ${Math.max(9, Math.round(R * 0.046))}px Georgia`;
  mCtx.fillStyle    = '#6b5842';
  mCtx.textAlign    = 'left';
  mCtx.textBaseline = 'alphabetic';
  mCtx.fillText('cent', cx - R * 0.88, cy + 18);

  mCtx.save();
  mCtx.font      = `italic bold ${Math.round(R * 0.075)}px Georgia`;
  mCtx.fillStyle = 'rgba(120,80,40,0.12)';
  mCtx.textAlign = 'center';
  mCtx.textBaseline = 'middle';
  mCtx.translate(cx, cy - R * 0.44);
  mCtx.rotate(-0.08);
  mCtx.fillText('Afinador Pro', 0, 0);
  mCtx.restore();

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

  fCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = fretCanvas.width  / dpr;
  const H = fretCanvas.height / dpr;
  fCtx.clearRect(0, 0, W, H);

  const pegW     = 72;
  const numFrets = 2.5;
  const fretW    = (W - pegW) / numFrets;

  fCtx.fillStyle = '#140a04';
  fCtx.fillRect(0, 0, pegW, H);

  const woodGrad = fCtx.createLinearGradient(pegW, 0, W, 0);
  woodGrad.addColorStop(0,    '#2e1a0a');
  woodGrad.addColorStop(0.25, '#3d2612');
  woodGrad.addColorStop(0.6,  '#2b1a0a');
  woodGrad.addColorStop(1,    '#1e1208');
  fCtx.fillStyle = woodGrad;
  fCtx.fillRect(pegW, 0, W - pegW, H);

  for (let y = 0; y < H; y += 18) {
    fCtx.beginPath();
    fCtx.moveTo(pegW, y);
    fCtx.lineTo(W, y);
    fCtx.strokeStyle = 'rgba(255,200,120,0.025)';
    fCtx.lineWidth = 8;
    fCtx.stroke();
  }

  for (let f = 0; f <= 2; f++) {
    const x = pegW + f * fretW;

    if (f === 0) {
      const nutGrad = fCtx.createLinearGradient(x - 4, 0, x + 4, 0);
      nutGrad.addColorStop(0,   '#a09070');
      nutGrad.addColorStop(0.4, '#e8dcc0');
      nutGrad.addColorStop(1,   '#907850');
      fCtx.fillStyle = nutGrad;
      fCtx.fillRect(x - 4, 0, 7, H);
    } else {
      const fGrad = fCtx.createLinearGradient(x - 1, 0, x + 2, 0);
      fGrad.addColorStop(0,   'rgba(160,145,110,0.6)');
      fGrad.addColorStop(0.5, 'rgba(220,205,165,0.85)');
      fGrad.addColorStop(1,   'rgba(140,125,90,0.5)');
      fCtx.fillStyle = fGrad;
      fCtx.fillRect(x - 1, 0, 3, H);
    }
  }

  [1, 2].forEach(f => {
    const x = pegW + (f - 0.5) * fretW;
    const y = H / 2;

    fCtx.beginPath();
    fCtx.arc(x, y, 7.5, 0, Math.PI * 2);
    fCtx.fillStyle = 'rgba(210,190,140,0.18)';
    fCtx.fill();
    fCtx.strokeStyle = 'rgba(210,190,140,0.35)';
    fCtx.lineWidth = 1;
    fCtx.stroke();
  });
}

// ═══════════════════════════════════════════════════════
//  MATHEMATICAL FORMULAS (gtuner engine)
// ═══════════════════════════════════════════════════════

/** Converts frequency (Hz) to fractional MIDI note number (e.g. 440 Hz -> 69.0) */
function frequencyToNumber(freq, a4 = A4_FREQ) {
  if (!freq || freq <= 0) return 0;
  return 12 * Math.log2(freq / a4) + 69;
}

/** Converts MIDI note number back to frequency in Hz */
function numberToFrequency(number, a4 = A4_FREQ) {
  return a4 * Math.pow(2.0, (number - 69) / 12.0);
}

/** Converts MIDI note number to note name string (e.g. 69 -> 'A') */
function numberToNoteName(number) {
  const idx = ((Math.round(number) % 12) + 12) % 12;
  return NOTES[idx];
}

// Microphone sensitivity level (0 = muted/no audio, 100 = maximum sensitivity)
let noiseReductionLevel = 70;

function detectPitch(buf, sampleRate) {
  // If sensitivity is 0, microphone receives nothing (completely muted)
  if (noiseReductionLevel <= 0) {
    return null;
  }

  const size = buf.length;
  let rms = 0;

  for (let i = 0; i < size; i++) {
    const val = buf[i];
    rms += val * val;
  }
  rms = Math.sqrt(rms / size);

  // When sensitivity is 100: base threshold is at its lowest (0.002, maximum mic capture)
  // As sensitivity decreases towards 1: threshold progressively increases up to 0.08
  const sensFactor = (100 - noiseReductionLevel) / 100;
  const baseNoiseThreshold = 0.002 + sensFactor * 0.078;
  if (rms < baseNoiseThreshold) {
    return null;
  }

  // gtuner zero-crossing edge trimming (adapts if signal is softer)
  let r1 = 0, r2 = size - 1, thres = Math.min(0.2, rms * 1.5);
  for (let i = 0; i < size / 2; i++) {
    if (Math.abs(buf[i]) < thres) { r1 = i; break; }
  }
  for (let i = 1; i < size / 2; i++) {
    if (Math.abs(buf[size - i]) < thres) { r2 = size - i; break; }
  }

  const trimmedBuf = (r2 > r1 && (r2 - r1) >= 256) ? buf.slice(r1, r2) : buf;
  const trimmedLen = trimmedBuf.length;
  if (trimmedLen < 128) return null;

  const c = new Float32Array(trimmedLen);
  for (let i = 0; i < trimmedLen; i++) {
    let sum = 0;
    for (let j = 0; j < trimmedLen - i; j++) {
      sum += trimmedBuf[j] * trimmedBuf[j + i];
    }
    c[i] = sum;
  }

  let d = 0;
  while (d < trimmedLen - 1 && c[d] > c[d + 1]) d++;

  let maxval = -1, maxpos = -1;
  for (let i = d; i < trimmedLen; i++) {
    if (c[i] > maxval) {
      maxval = c[i];
      maxpos = i;
    }
  }

  if (maxpos <= 0) return null;

  let T0 = maxpos;
  // Exact gtuner parabolic interpolation
  if (T0 > 0 && T0 < trimmedLen - 1) {
    const x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1];
    const a = (x1 + x3 - 2 * x2) / 2;
    const b = (x3 - x1) / 2;
    if (a !== 0) {
      T0 = T0 - b / (2 * a);
    }
  }

  // Confidence is the ratio of correlation peak to energy at lag 0
  const confidence = c[0] > 0 ? (maxval / c[0]) : 0;
  const freq = sampleRate / T0;

  // Guitar & instrument range (60 Hz to 1200 Hz) and minimum clarity threshold
  if (freq >= 60 && freq <= 1200 && confidence >= 0.35) {
    return { freq, confidence, rms };
  }
  return null;
}

// ── Freq → detailed note & cents (gtuner standard) ────
function freqToNote(freq) {
  if (!freq || freq <= 0 || isNaN(freq)) return null;

  const noteNumber = frequencyToNumber(freq, A4_FREQ);
  const nearestNoteNumber = Math.round(noteNumber);
  const nearestNoteFreq = numberToFrequency(nearestNoteNumber, A4_FREQ);

  const freqDifference = nearestNoteFreq - freq;
  const semitoneStep = nearestNoteFreq - numberToFrequency(nearestNoteNumber - 1, A4_FREQ);

  // Exact difference in cents
  const diffCents = semitoneStep === 0 ? 0 : (freqDifference / semitoneStep) * 100;
  const cents = Math.max(-50, Math.min(50, -diffCents));

  const note = numberToNoteName(nearestNoteNumber);
  const octave = Math.floor(nearestNoteNumber / 12) - 1;

  if (octave < 1 || octave > 8) return null;

  return { note, octave, cents, freq, noteNumber, nearestNoteNumber, freqDifference, semitoneStep };
}

// ═══════════════════════════════════════════════════════
//  AUDIO SETUP
// ═══════════════════════════════════════════════════════
async function startTuner() {
  const overlay = document.getElementById('mic-overlay');
  if (overlay) overlay.remove();

  try {
    ensureAudioCtx();
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = FFT_SIZE; // 2048 matches gtuner BUF_SIZE

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    sourceNode = audioCtx.createMediaStreamSource(stream);
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

// Cents smoothing factor: fast enough to follow pitch changes, smooth enough to avoid jitter
const SMOOTH = 0.16;

let toneHitCounter = 0;
let nearestNoteBuffered = 69; // A4 default
let noteNumberCounter = 0;
const HITS_TILL_NOTE_NUMBER_UPDATE = 4; // responsive note switching matching gtuner
const NEEDLE_BUFFER_LENGTH = 10;
const needleBuffer = new Array(NEEDLE_BUFFER_LENGTH).fill(0);

let displayFreq = 329.6;

// Dynamic envelope tracking and smooth decay state
let peakRms = 0;
let holdFramesAfterPluck = 0;
let currentConfidence = 0;
let lastDetectedNote = 69;

function loop() {
  if (!isRunning) return;
  animFrame = requestAnimationFrame(loop);

  const dpr = window.devicePixelRatio || 1;

  // ── Pitch detection ──
  if (analyser) {
    analyser.getFloatTimeDomainData(timeDomainBuf);
    const pitchResult = detectPitch(timeDomainBuf, audioCtx.sampleRate);

    // Adaptive noise floor: decays slowly, rises when a strong pluck occurs
    peakRms *= 0.96;

    let validSignal = false;

    if (pitchResult) {
      const { freq, confidence, rms } = pitchResult;

      // Detect strong pluck (tope de la cuerda)
      if (rms > peakRms) {
        peakRms = rms;
        holdFramesAfterPluck = 25; // Lock onto the string fundamental across its decay
      }

      // Dynamic gate mapped with sensitivity (noiseReductionLevel):
      // When noiseReductionLevel = 100 (maximum sensitivity): minimal gate, picks up the subtlest notes
      // When noiseReductionLevel drops: raises gate and requires higher harmonic clarity
      const sensFactor = (100 - noiseReductionLevel) / 100;
      const gateRatio = 0.04 + sensFactor * 0.28;
      const minGate = 0.002 + sensFactor * 0.06;
      const dynamicGate = Math.max(minGate, peakRms * gateRatio);

      // Harmonic clarity required: 0.25 at 100% sensitivity, up to 0.65 at low sensitivity
      const minConfidence = 0.25 + sensFactor * 0.40;

      if (rms >= dynamicGate && confidence >= minConfidence) {
        validSignal = true;
        currentConfidence = confidence;
        const detected = freqToNote(freq);

        if (detected) {
          let { note, octave, cents, noteNumber, nearestNoteNumber, freqDifference, semitoneStep } = detected;

          if (lockedString !== null) {
            // Compute cents relative to the locked string's exact frequency
            const target = GUITAR_STRINGS[lockedString];
            const tMidi  = 12 * Math.log2(target.freq / A4_FREQ) + A4_MIDI;
            const dMidi  = 12 * Math.log2(freq / A4_FREQ) + A4_MIDI;
            cents        = Math.max(-50, Math.min(50, (dMidi - tMidi) * 100));
            note         = target.note.replace(/\d/, '');
            octave       = target.octave;
          }

          // Hysteresis: prevent changing note if we're in the decay phase of an active note unless energy strongly spikes
          const noteDistance = Math.abs(nearestNoteNumber - nearestNoteBuffered);
          const isNoteChange = noteDistance > 0;

          if (isNoteChange) {
            // Require more consistent hits or higher energy to switch to a completely different note
            noteNumberCounter++;
            const requiredHits = holdFramesAfterPluck > 0 ? 8 : HITS_TILL_NOTE_NUMBER_UPDATE;
            if (noteNumberCounter >= requiredHits) {
              nearestNoteBuffered = nearestNoteNumber;
              noteNumberCounter = 0;
            }
          } else {
            noteNumberCounter = 0;
          }

          if (holdFramesAfterPluck > 0) holdFramesAfterPluck--;

          // Compute exact deviation in cents and needle angle relative to the committed display note
          const bufferedNoteFreq = numberToFrequency(nearestNoteBuffered, A4_FREQ);
          const bufFreqDiff = bufferedNoteFreq - freq;
          const bufSemitoneStep = bufferedNoteFreq - numberToFrequency(nearestNoteBuffered - 1, A4_FREQ);
          const targetNeedleAngle = -90 * ((bufFreqDiff / (bufSemitoneStep || 1)) * 2);

          needleBuffer.shift();
          needleBuffer.push(targetNeedleAngle);
          const avgAngle = needleBuffer.reduce((a, b) => a + b, 0) / needleBuffer.length;
          targetAngle = Math.max(-50, Math.min(50, avgAngle));

          const bufferedCents = bufSemitoneStep === 0 ? 0 : Math.max(-50, Math.min(50, -(bufFreqDiff / bufSemitoneStep) * 100));

          displayNote   = numberToNoteName(nearestNoteBuffered);
          displayOctave = Math.floor(nearestNoteBuffered / 12) - 1;
          displayCents  = bufferedCents;
          displayFreq   = freq;

          // Comprobación de afinación en el punto exacto (< 5 cents) y disparo del sonido
          if (Math.abs(bufferedCents) <= IN_TUNE_CENTS) {
            toneHitCounter++;
            if (toneHitCounter >= 12) {
              playSuccessChime();
              toneHitCounter = 0;
            }
          } else {
            toneHitCounter = 0;
          }
        }
      }
    }

    if (!validSignal) {
      // Sound decaying into room ambient / silence:
      // Gently glide the needle back to center without jumping or fluttering the chord
      needleBuffer.shift();
      needleBuffer.push(0);
      const avgAngle = needleBuffer.reduce((a, b) => a + b, 0) / needleBuffer.length;
      targetAngle = avgAngle;
      displayCents *= 0.92;
      toneHitCounter = 0;
      if (holdFramesAfterPluck > 0) holdFramesAfterPluck--;
    }
  }

  // ── Needle — responsive and fluid interpolation ──
  needleAngle += (targetAngle - needleAngle) * 0.12;

  // ── Redraw meter ──
  mCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawMeter(needleAngle);

  // ── Update wheel & circle smoothly ──
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
//  SOUND CHIME SETTING
// ═══════════════════════════════════════════════════════
const chimeToggle = document.getElementById('chime-toggle');
if (chimeToggle) {
  chimeToggle.addEventListener('change', () => {
    isMuted = !chimeToggle.checked;
  });
}

// ═══════════════════════════════════════════════════════
//  NOISE REDUCTION SLIDER SETTING
// ═══════════════════════════════════════════════════════
const noiseSlider   = document.getElementById('noise-reduction-slider');
const noiseValEl    = document.getElementById('noise-reduction-val');
const btnResetNoise = document.getElementById('btn-reset-noise');

if (noiseSlider) {
  noiseSlider.addEventListener('input', () => {
    noiseReductionLevel = parseInt(noiseSlider.value, 10) || 0;
    if (noiseValEl) {
      noiseValEl.textContent = `${noiseReductionLevel}%`;
    }
  });
}

if (btnResetNoise && noiseSlider) {
  btnResetNoise.addEventListener('click', () => {
    noiseReductionLevel = 70;
    noiseSlider.value = 70;
    if (noiseValEl) {
      noiseValEl.textContent = '70%';
    }
  });
}

// ═══════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════

// Stop vibrations on resize to avoid stale canvas dimensions
window.addEventListener('resize', stopAllVibrations);

window.addEventListener('DOMContentLoaded', init);
