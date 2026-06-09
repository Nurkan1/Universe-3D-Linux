// Synthesized sound effects via Web Audio API (no audio assets needed).
// All sounds are short, soft and "spacey" to match the universe theme.
let ctx = null;
let master = null;
let volume = 0.5; // desired volume, applied lazily once the context exists
let recDest = null; // MediaStreamDestination used to feed screen recordings

/** Lazy init: AudioContext must be created after a user gesture. */
function ensureCtx() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function setVolume(v) {
  volume = v;
  if (master) master.gain.value = v;
}

export function getVolume() {
  return volume;
}

/** Audio stream of all SFX output, mixable into a screen recording. */
export function getAudioStream() {
  ensureCtx();
  if (!recDest) {
    recDest = ctx.createMediaStreamDestination();
    master.connect(recDest);
  }
  return recDest.stream;
}

/** Simple enveloped oscillator note. */
function tone({ freq, endFreq, type = 'sine', dur = 0.15, gain = 0.2, delay = 0 }) {
  if (volume <= 0) return;
  const ac = ensureCtx();
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

/** Filtered noise burst (used for the warp whoosh). */
function noise({ dur = 0.5, gain = 0.3, from = 400, to = 4000, delay = 0 }) {
  if (volume <= 0) return;
  const ac = ensureCtx();
  const t0 = ac.currentTime + delay;
  const len = Math.ceil(ac.sampleRate * dur);
  const buffer = ac.createBuffer(1, len, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 1.2;
  filter.frequency.setValueAtTime(from, t0);
  filter.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + dur * 0.25);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

/** Subtle high blip when hovering a planet. */
export function playHover() {
  tone({ freq: 1400, endFreq: 1800, dur: 0.06, gain: 0.06 });
}

/** Soft UI click (buttons, layout switch). */
export function playClick() {
  tone({ freq: 700, endFreq: 500, type: 'triangle', dur: 0.08, gain: 0.14 });
}

/** Rising warp whoosh when launching an app. */
export function playWarp() {
  noise({ dur: 0.65, gain: 0.28, from: 300, to: 5200 });
  tone({ freq: 220, endFreq: 1320, type: 'sawtooth', dur: 0.6, gain: 0.08 });
  tone({ freq: 880, endFreq: 2640, dur: 0.5, gain: 0.07, delay: 0.1 });
}

/** Descending vortex when the sun absorbs the planets. */
export function playAbsorb() {
  noise({ dur: 1.1, gain: 0.26, from: 4800, to: 180 });
  tone({ freq: 980, endFreq: 90, type: 'sawtooth', dur: 1.0, gain: 0.09 });
  tone({ freq: 1960, endFreq: 180, dur: 0.9, gain: 0.06, delay: 0.05 });
}

/** Rising burst when the sun expels the planets back out. */
export function playExpel() {
  noise({ dur: 0.8, gain: 0.3, from: 200, to: 5600 });
  tone({ freq: 120, endFreq: 1100, type: 'sawtooth', dur: 0.7, gain: 0.09 });
  tone({ freq: 440, endFreq: 1760, dur: 0.55, gain: 0.08, delay: 0.08 });
}

/** Two-note sparkle when toggling a favorite. */
export function playFavorite(adding) {
  if (adding) {
    tone({ freq: 880, dur: 0.1, gain: 0.14 });
    tone({ freq: 1320, dur: 0.16, gain: 0.14, delay: 0.09 });
  } else {
    tone({ freq: 660, dur: 0.1, gain: 0.12 });
    tone({ freq: 440, dur: 0.16, gain: 0.12, delay: 0.09 });
  }
}
