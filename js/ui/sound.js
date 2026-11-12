// Sound effects, synthesised with Web Audio so the app ships no audio files.

const STORAGE_KEY = 'overdrive.muted';

let context = null;
let master = null;
let muted = readMuted();

function readMuted() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false; // private browsing or blocked storage: default to sound on
  }
}

function audio() {
  const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!context) {
    context = new AudioContextClass();
    master = context.createGain();
    master.gain.value = 0.5;
    master.connect(context.destination);
  }
  if (context.state === 'suspended') context.resume().catch(() => {});
  return context;
}

/** Browsers only allow audio after a user gesture, so call this from the first click or key press. */
export function unlockAudio() {
  audio();
}

export function isMuted() {
  return muted;
}

export function setMuted(value) {
  muted = Boolean(value);
  try {
    localStorage.setItem(STORAGE_KEY, muted ? '1' : '0');
  } catch {
    // Not persisted, still applies for this visit.
  }
}

/**
 * One oscillator note with a quick attack and an exponential fade.
 * @param {{freq: number, to?: number, type?: OscillatorType, duration?: number, gain?: number, delay?: number}} note
 */
function tone({ freq, to, type = 'square', duration = 0.15, gain = 0.25, delay = 0 }) {
  if (muted) return;
  const ctx = audio();
  if (!ctx) return;
  const start = ctx.currentTime + delay;
  const oscillator = ctx.createOscillator();
  const envelope = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(freq, start);
  if (to) oscillator.frequency.exponentialRampToValueAtTime(to, start + duration);
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(gain, start + 0.01);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(envelope).connect(master);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

/** A burst of filtered white noise, for impacts and explosions. */
function noise({ duration = 0.3, from = 2000, to = 200, gain = 0.4, delay = 0 }) {
  if (muted) return;
  const ctx = audio();
  if (!ctx) return;
  const start = ctx.currentTime + delay;
  const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) samples[i] = Math.random() * 2 - 1;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(from, start);
  filter.frequency.exponentialRampToValueAtTime(to, start + duration);
  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(gain, start);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  source.connect(filter).connect(envelope).connect(master);
  source.start(start);
}

export const sfx = {
  click: () => tone({ freq: 660, type: 'triangle', duration: 0.05, gain: 0.12 }),
  connect: () => {
    tone({ freq: 440, type: 'triangle', duration: 0.1 });
    tone({ freq: 660, type: 'triangle', duration: 0.14, delay: 0.09 });
  },
  disconnect: () => {
    tone({ freq: 440, type: 'triangle', duration: 0.1 });
    tone({ freq: 294, type: 'triangle', duration: 0.18, delay: 0.09 });
  },
  countdown: () => tone({ freq: 440, duration: 0.18, gain: 0.22 }),
  go: () => tone({ freq: 880, duration: 0.55, gain: 0.26 }),
  lap: () => {
    tone({ freq: 784, type: 'triangle', duration: 0.09 });
    tone({ freq: 1175, type: 'triangle', duration: 0.14, delay: 0.08 });
  },
  finalLap: () => {
    for (let i = 0; i < 3; i += 1) tone({ freq: 988, type: 'triangle', duration: 0.08, delay: i * 0.11 });
  },
  finish: () => {
    [523, 659, 784, 1047].forEach((freq, i) => tone({ freq, type: 'triangle', duration: 0.2, delay: i * 0.12 }));
  },
  lose: () => {
    [392, 330, 262].forEach((freq, i) => tone({ freq, type: 'sawtooth', duration: 0.25, gain: 0.16, delay: i * 0.18 }));
  },
  fire: () => tone({ freq: 1400, to: 220, type: 'sawtooth', duration: 0.16, gain: 0.2 }),
  heavy: () => {
    tone({ freq: 300, to: 60, type: 'sawtooth', duration: 0.4, gain: 0.26 });
    noise({ duration: 0.25, from: 1200, to: 150, gain: 0.2 });
  },
  hit: () => {
    noise({ duration: 0.22, from: 3000, to: 300, gain: 0.4 });
    tone({ freq: 160, to: 50, type: 'square', duration: 0.2, gain: 0.2 });
  },
  miss: () => tone({ freq: 240, to: 180, type: 'sine', duration: 0.1, gain: 0.1 }),
  powerZone: () => {
    tone({ freq: 220, to: 1760, type: 'sawtooth', duration: 0.35, gain: 0.2 });
    noise({ duration: 0.5, from: 4000, to: 120, gain: 0.45, delay: 0.3 });
  },
  knockout: () => {
    noise({ duration: 0.9, from: 2500, to: 60, gain: 0.5 });
    tone({ freq: 400, to: 40, type: 'sawtooth', duration: 0.8, gain: 0.25 });
  },
  offTrack: () => tone({ freq: 200, to: 120, type: 'square', duration: 0.3, gain: 0.16 }),
  lowBattery: () => {
    tone({ freq: 330, type: 'square', duration: 0.12, gain: 0.14 });
    tone({ freq: 330, type: 'square', duration: 0.12, gain: 0.14, delay: 0.2 });
  },
};
