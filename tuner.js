/**
 * tuner.js — Guitar Tuner
 *
 * Features:
 *  • Web Audio API pitch detection (autocorrelation / YIN-like)
 *  • Animated dial needle (canvas)
 *  • Note wheel showing prev2 → prev → CURRENT → next → next2
 *  • Guitar fretboard with 6 strings; tap a string to lock to that note
 *  • Indicator light: red (off), yellow (close), green (in tune)
 */

'use strict';

// ═══════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════

/** Standard guitar strings in ascending order of pitch */
const GUITAR_STRINGS = [
  { name: 'Mi',  octave: 2, note: 'E', freq: 82.41  },  // 6th string (thickest)
  { name: 'La',  octave: 2, note: 'A', freq: 110.00 },  // 5th
  { name: 'Re',  octave: 3, note: 'D', freq: 146.83 },  // 4th
  { name: 'Sol', octave: 3, note: 'G', freq: 196.00 },  // 3rd
  { name: 'Si',  octave: 3, note: 'B', freq: 246.94 },  // 2nd
  { name: 'Mi',  octave: 4, note: 'E', freq: 329.63 },  // 1st (thinnest)
];

/** All chromatic notes (we'll use both sharp and flat representations) */
const NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

/** Enharmonic display names (flat preferred when between sharp notes) */
const NOTE_DISPLAY = {
  'C':'C', 'C#':'C#', 'D':'D', 'D#':'D#', 'E':'E',
  'F':'F', 'F#':'F#', 'G':'G', 'G#':'G#', 'A':'A', 'A#':'A#', 'B':'B'
};

const A4_FREQ  = 440;       // reference pitch
const A4_MIDI  = 69;        // MIDI note number for A4
const IN_TUNE_CENTS  = 5;   // ±cents considered "in tune"
const CLOSE_CENTS    = 15;  // ±cents considered "close"
const FFT_SIZE       = 4096;
const MIN_CONFIDENCE = 0.92; // autocorrelation threshold

// ═══════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════
let audioCtx, analyser, sourceNode, buffer;
let isRunning   = false;
let lockedString = null; // index into GUITAR_STRINGS (null = free)
let animFrame;

// Smoothed display values
let displayCents = 0;      // current smoothed cents deviation
let displayNote  = 'E';    // name of detected note
let displayOctave = 2;

// Needle animation
let needleAngle  = 0;      // current rendered angle (degrees, 0=centre)
let targetAngle  = 0;      // target angle from pitch data

// ═══════════════════════════════════════════════════════
//  DOM REFS
// ═══════════════════════════════════════════════════════
const meterCanvas    = document.getElementById('meter-canvas');
const mCtx           = meterCanvas.getContext('2d');
const indicatorLight = document.getElementById('indicator-light');
const notePrev2El    = document.getElementById('note-prev2');
const notePrevEl     = document.getElementById('note-prev');
const noteCurrEl     = document.getElementById('note-curr-inner');
const noteNextEl     = document.getElementById('note-next');
const noteNext2El    = document.getElementById('note-next2');
const stringsList    = document.getElementById('strings-list');
const fretCanvas     = document.getElementById('fretboard-canvas');
const fCtx           = fretCanvas.getContext('2d');

// ═══════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════
function init() {
  buildFretboard();
  resizeCanvases();
  drawMeter(0);
  updateNoteWheel('E', 0);
  showMicOverlay();

  window.addEventListener('resize', () => {
    resizeCanvases();
    drawMeter(needleAngle);
    drawFretboardBg();
  });
}

// ─── Mic permission overlay ──────────────────────────
function showMicOverlay() {
  const overlay = document.createElement('div');
  overlay.id = 'mic-overlay';
  overlay.innerHTML = `
    <h2>🎙 Micrófono requerido</h2>
    <p>El afinador necesita acceso al micrófono para escuchar tu guitarra.</p>
    <button id="mic-btn">Activar afinador</button>
  `;
  document.body.appendChild(overlay);
  document.getElementById('mic-btn').addEventListener('click', startTuner);
}

// ═══════════════════════════════════════════════════════
//  FRETBOARD
// ═══════════════════════════════════════════════════════
function buildFretboard() {
  // Strings displayed from thinnest (Mi4) to thickest (Mi2), top to bottom
  const display = [...GUITAR_STRINGS].reverse();

  display.forEach((str, i) => {
    const row = document.createElement('div');
    row.className = 'string-row';
    row.dataset.idx = GUITAR_STRINGS.length - 1 - i; // index in original array

    // string thickness
    const thicknessMap = [1.5, 2, 2.5, 3, 3.5, 4.5]; // thinnest first (display order)
    const sw = thicknessMap[i];

    row.innerHTML = `
      <div class="string-peg">
        <span class="note-name">${str.name}</span><span class="octave">${str.octave}</span>
      </div>
      <div class="string-line" style="--sw:${sw}px"></div>
    `;

    row.addEventListener('click', () => toggleStringLock(parseInt(row.dataset.idx), row));
    stringsList.appendChild(row);
  });
}

function toggleStringLock(idx, rowEl) {
  document.querySelectorAll('.string-row').forEach(r => r.classList.remove('active'));

  if (lockedString === idx) {
    lockedString = null;
  } else {
    lockedString = idx;
    rowEl.classList.add('active');
    // Snap display to that string's note immediately
    const s = GUITAR_STRINGS[idx];
    displayNote = s.note;
    displayOctave = s.octave;
    updateNoteWheel(s.note, 0);
  }
}

// ═══════════════════════════════════════════════════════
//  CANVAS RESIZE
// ═══════════════════════════════════════════════════════
function resizeCanvases() {
  const mb = document.getElementById('meter-bg');
  const rect = mb.getBoundingClientRect();
  meterCanvas.width  = Math.round(rect.width)  * devicePixelRatio;
  meterCanvas.height = Math.round(rect.height) * devicePixelRatio;
  mCtx.scale(devicePixelRatio, devicePixelRatio);
  meterCanvas.style.width  = rect.width  + 'px';
  meterCanvas.style.height = rect.height + 'px';

  const fp = document.getElementById('fretboard-panel');
  const fpRect = fp.getBoundingClientRect();
  fretCanvas.width  = Math.round(fpRect.width)  * devicePixelRatio;
  fretCanvas.height = Math.round(fpRect.height) * devicePixelRatio;
  fCtx.scale(devicePixelRatio, devicePixelRatio);
  fretCanvas.style.width  = fpRect.width  + 'px';
  fretCanvas.style.height = fpRect.height + 'px';
  drawFretboardBg();
}

// ═══════════════════════════════════════════════════════
//  METER DIAL DRAWING
// ═══════════════════════════════════════════════════════
function drawMeter(angleDeg) {
  const W = meterCanvas.width  / devicePixelRatio;
  const H = meterCanvas.height / devicePixelRatio;
  mCtx.clearRect(0, 0, W, H);

  const cx = W / 2;
  const cy = H * 1.05;    // pivot below bottom edge for nice sweep
  const R  = Math.min(W * 0.85, H * 1.6);

  // ── Dial background arc ──
  const startA = Math.PI * 1.15;
  const endA   = Math.PI * 1.85;

  // Cream dial face
  mCtx.beginPath();
  mCtx.moveTo(cx, cy);
  mCtx.arc(cx, cy, R, startA, endA);
  mCtx.closePath();
  const grad = mCtx.createRadialGradient(cx, cy - R * 0.3, R * 0.1, cx, cy, R);
  grad.addColorStop(0,   '#f5ead2');
  grad.addColorStop(0.6, '#e8d8b8');
  grad.addColorStop(1,   '#c8b898');
  mCtx.fillStyle = grad;
  mCtx.fill();

  // Outer arc border
  mCtx.beginPath();
  mCtx.arc(cx, cy, R, startA, endA);
  mCtx.strokeStyle = '#8a7050';
  mCtx.lineWidth   = 3;
  mCtx.stroke();

  // ── Scale ticks & labels ──
  const totalAngle = (endA - startA);  // radians
  const tickData = [
    { val: -50, major: true  },
    { val: -40, major: true  },
    { val: -30, major: true  },
    { val: -20, major: true  },
    { val: -10, major: true  },
    { val:   0, major: true  },
    { val:  10, major: true  },
    { val:  20, major: true  },
    { val:  30, major: true  },
    { val:  40, major: true  },
    { val:  50, major: true  },
  ];
  // Minor ticks every 5 cents
  for (let v = -50; v <= 50; v += 5) {
    if (v % 10 !== 0) tickData.push({ val: v, major: false });
  }

  tickData.forEach(({ val, major }) => {
    const norm  = (val + 50) / 100;           // 0..1
    const angle = startA + norm * totalAngle;  // radians
    const cos = Math.cos(angle), sin = Math.sin(angle);

    const r1 = R * (major ? 0.82 : 0.87);
    const r2 = R * 0.93;

    mCtx.beginPath();
    mCtx.moveTo(cx + cos * r1, cy + sin * r1);
    mCtx.lineTo(cx + cos * r2, cy + sin * r2);
    mCtx.strokeStyle = major ? '#555' : '#999';
    mCtx.lineWidth   = major ? 2 : 1;
    mCtx.stroke();

    if (major && val % 10 === 0) {
      const rL  = R * 0.75;
      const txt = val === 0 ? '0' : (val > 0 ? '+' + val : '' + val);
      mCtx.font      = `bold ${Math.round(R * 0.045)}px Arial`;
      mCtx.fillStyle = '#333';
      mCtx.textAlign = 'center';
      mCtx.textBaseline = 'middle';
      mCtx.fillText(txt, cx + cos * rL, cy + sin * rL);
    }
  });

  // "cent" label
  mCtx.font      = `italic ${Math.round(R * 0.04)}px Georgia`;
  mCtx.fillStyle = '#555';
  mCtx.textAlign = 'left';
  mCtx.textBaseline = 'alphabetic';
  mCtx.fillText('cent', cx - R * 0.88, cy - R * 0.06);

  // Watermark text
  mCtx.save();
  mCtx.font      = `italic bold ${Math.round(R * 0.065)}px Georgia`;
  mCtx.fillStyle = 'rgba(120,80,40,0.18)';
  mCtx.textAlign = 'center';
  mCtx.textBaseline = 'middle';
  mCtx.translate(cx, cy - R * 0.42);
  mCtx.rotate(-0.15);
  mCtx.fillText('Afinador Pro', 0, 0);
  mCtx.restore();

  // ── Needle ──
  const needleRad = startA + ((angleDeg + 50) / 100) * totalAngle;
  const nLen = R * 0.88;
  const nCos = Math.cos(needleRad), nSin = Math.sin(needleRad);

  // Shadow
  mCtx.save();
  mCtx.shadowColor   = 'rgba(0,0,0,0.25)';
  mCtx.shadowBlur    = 4;
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

  // Pivot dot
  mCtx.beginPath();
  mCtx.arc(cx, cy, 7, 0, Math.PI * 2);
  mCtx.fillStyle = '#333';
  mCtx.fill();

  // Red centre zone
  const zoneHalf = (10 / 100) * totalAngle;
  const centreA  = startA + 0.5 * totalAngle;
  mCtx.beginPath();
  mCtx.moveTo(cx, cy);
  mCtx.arc(cx, cy, R * 0.92, centreA - zoneHalf, centreA + zoneHalf);
  mCtx.closePath();
  mCtx.fillStyle = 'rgba(200, 50, 50, 0.1)';
  mCtx.fill();
}

// ═══════════════════════════════════════════════════════
//  FRETBOARD BACKGROUND
// ═══════════════════════════════════════════════════════
function drawFretboardBg() {
  const W = fretCanvas.width  / devicePixelRatio;
  const H = fretCanvas.height / devicePixelRatio;
  fCtx.clearRect(0, 0, W, H);

  const offsetX = 70; // peg area width
  const numFrets = 5;
  const fretW    = (W - offsetX) / numFrets;

  // Wood grain background gradient
  const grad = fCtx.createLinearGradient(offsetX, 0, W, 0);
  grad.addColorStop(0,    '#2b1a0d');
  grad.addColorStop(0.3,  '#3d2714');
  grad.addColorStop(0.7,  '#2e1c0c');
  grad.addColorStop(1,    '#1f1208');
  fCtx.fillStyle = grad;
  fCtx.fillRect(offsetX, 0, W - offsetX, H);

  // Fret lines
  for (let f = 0; f <= numFrets; f++) {
    const x = offsetX + f * fretW;
    const fretGrad = fCtx.createLinearGradient(x, 0, x + 3, 0);
    fretGrad.addColorStop(0, '#c8b890');
    fretGrad.addColorStop(0.5, '#e8d8a8');
    fretGrad.addColorStop(1, '#a89060');
    fCtx.fillStyle = fretGrad;
    fCtx.fillRect(x - 1.5, 0, 3, H);
  }

  // Fret position dots (3rd and 5th fret)
  const dotFrets = [2, 4];
  const dotY = H / 2;
  dotFrets.forEach(f => {
    const x = offsetX + (f - 0.5) * fretW;
    fCtx.beginPath();
    fCtx.arc(x, dotY, 8, 0, Math.PI * 2);
    fCtx.fillStyle = 'rgba(220,200,160,0.2)';
    fCtx.fill();
    fCtx.strokeStyle = 'rgba(220,200,160,0.4)';
    fCtx.lineWidth = 1;
    fCtx.stroke();
  });
}

// ═══════════════════════════════════════════════════════
//  NOTE WHEEL UPDATE
// ═══════════════════════════════════════════════════════
function noteIndex(noteName) {
  return NOTES.indexOf(noteName);
}

function noteAt(idx) {
  return NOTES[((idx % 12) + 12) % 12];
}

function formatNoteHtml(noteName) {
  if (noteName.includes('#')) {
    return noteName[0] + '<sup style="font-size:0.65em;vertical-align:super">#</sup>';
  }
  return noteName;
}

function updateNoteWheel(note, cents) {
  const idx = noteIndex(note);
  if (idx === -1) return;

  notePrev2El.innerHTML = formatNoteHtml(noteAt(idx - 2));
  notePrevEl .innerHTML = formatNoteHtml(noteAt(idx - 1));
  noteCurrEl .innerHTML = formatNoteHtml(note);
  noteNextEl .innerHTML = formatNoteHtml(noteAt(idx + 1));
  noteNext2El.innerHTML = formatNoteHtml(noteAt(idx + 2));

  // Indicator light
  const absCents = Math.abs(cents);
  if (absCents <= IN_TUNE_CENTS) {
    indicatorLight.className = 'light-green';
  } else if (absCents <= CLOSE_CENTS) {
    indicatorLight.className = 'light-yellow';
  } else {
    indicatorLight.className = 'light-red';
  }
}

// ═══════════════════════════════════════════════════════
//  AUDIO SETUP
// ═══════════════════════════════════════════════════════
async function startTuner() {
  // Remove overlay
  const overlay = document.getElementById('mic-overlay');
  if (overlay) overlay.remove();

  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.3;

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    sourceNode = audioCtx.createMediaStreamSource(stream);
    sourceNode.connect(analyser);

    buffer = new Float32Array(analyser.fftSize);
    isRunning = true;
    loop();
  } catch (err) {
    alert('No se pudo acceder al micrófono: ' + err.message);
    showMicOverlay();
  }
}

// ═══════════════════════════════════════════════════════
//  PITCH DETECTION — Autocorrelation (McLeod method)
// ═══════════════════════════════════════════════════════
function detectPitch(buf, sampleRate) {
  const SIZE   = buf.length;
  const MAX_SAMPLES = Math.floor(SIZE / 2);

  // RMS check — silence?
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return null;

  // Autocorrelation
  const corr = new Float32Array(MAX_SAMPLES);
  for (let lag = 0; lag < MAX_SAMPLES; lag++) {
    let sum = 0;
    for (let i = 0; i < MAX_SAMPLES; i++) {
      sum += buf[i] * buf[i + lag];
    }
    corr[lag] = sum;
  }

  // Find first dip then first peak
  let d = 1;
  while (d < MAX_SAMPLES && corr[d] > corr[d - 1]) d++;
  let maxVal = -1, maxPos = -1;
  for (let i = d; i < MAX_SAMPLES; i++) {
    if (corr[i] > maxVal) { maxVal = corr[i]; maxPos = i; }
  }

  if (maxPos === -1 || maxVal / corr[0] < MIN_CONFIDENCE) return null;

  // Parabolic interpolation for sub-sample accuracy
  const y1 = corr[maxPos - 1] || corr[maxPos];
  const y2 = corr[maxPos];
  const y3 = corr[maxPos + 1] || corr[maxPos];
  const shift = (y3 - y1) / (2 * (2 * y2 - y1 - y3));
  return sampleRate / (maxPos + shift);
}

// ═══════════════════════════════════════════════════════
//  FREQ → NOTE CONVERSION
// ═══════════════════════════════════════════════════════
function freqToNote(freq) {
  if (!freq || freq <= 0) return null;
  const midiFloat = 12 * Math.log2(freq / A4_FREQ) + A4_MIDI;
  const midiRound = Math.round(midiFloat);
  const cents     = (midiFloat - midiRound) * 100;
  const noteIdx   = ((midiRound % 12) + 12) % 12;
  const octave    = Math.floor(midiRound / 12) - 1;
  return { note: NOTES[noteIdx], octave, cents, freq };
}

// ═══════════════════════════════════════════════════════
//  MAIN LOOP
// ═══════════════════════════════════════════════════════
const SMOOTH = 0.25; // interpolation factor

function loop() {
  if (!isRunning) return;
  animFrame = requestAnimationFrame(loop);

  analyser.getFloatTimeDomainData(buffer);
  const freq = detectPitch(buffer, audioCtx.sampleRate);
  const detected = freqToNote(freq);

  if (detected) {
    let { note, octave, cents } = detected;

    // If a string is locked, compute cents relative to that string
    if (lockedString !== null) {
      const target = GUITAR_STRINGS[lockedString];
      const targetMidi = 12 * Math.log2(target.freq / A4_FREQ) + A4_MIDI;
      const detectedMidi = 12 * Math.log2(detected.freq / A4_FREQ) + A4_MIDI;
      cents = (detectedMidi - targetMidi) * 100;
      // clamp to ±50
      cents = Math.max(-50, Math.min(50, cents));
      note   = target.note;
      octave = target.octave;
    }

    // Smooth
    displayCents  = displayCents  + SMOOTH * (cents  - displayCents);
    displayNote   = note;
    displayOctave = octave;

    targetAngle = Math.max(-50, Math.min(50, displayCents));
  } else {
    // No signal — drift back to centre slowly
    displayCents = displayCents * 0.95;
    targetAngle  = displayCents;
  }

  // Animate needle toward target
  needleAngle += (targetAngle - needleAngle) * 0.15;

  // Redraw
  mCtx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  drawMeter(needleAngle);
  updateNoteWheel(displayNote || 'E', displayCents);
}

// ═══════════════════════════════════════════════════════
//  NAV BAR (placeholder)
// ═══════════════════════════════════════════════════════
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// ═══════════════════════════════════════════════════════
//  BOOTSTRAP
// ═══════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', init);
