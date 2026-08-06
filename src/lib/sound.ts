// A tiny, dependency-free notification "chime" synthesized with the Web Audio
// API — no binary asset to ship. Browsers block audio until the user interacts
// with the page, so we lazily create/resume the AudioContext on the first
// gesture and again right before playing.

const MUTE_KEY = 'nearside.sound.muted';

let ctx: AudioContext | null = null;

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  return ctx;
}

/** Wire once at startup: unlock audio on the first user gesture. */
export function initSoundUnlock(): void {
  if (typeof window === 'undefined') return;
  const unlock = () => {
    const c = getCtx();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
  };
  const opts = { once: true, passive: true } as const;
  window.addEventListener('pointerdown', unlock, opts);
  window.addEventListener('keydown', unlock, opts);
}

export function isSoundMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setSoundMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    /* ignore storage failures */
  }
}

/** Play a soft two-note chime, unless the user muted sound. */
export function playNotificationSound(): void {
  if (isSoundMuted()) return;
  const c = getCtx();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});

  const now = c.currentTime;
  const master = c.createGain();
  // Unity: the per-note gains below carry the whole envelope.
  master.gain.value = 1;
  master.connect(c.destination);

  // Two quick ascending notes (G5 -> C6) with a gentle bell-like envelope.
  const notes = [
    { freq: 784, at: 0 },
    { freq: 1047, at: 0.12 },
  ];

  for (const { freq, at } of notes) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;

    const start = now + at;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);

    osc.connect(gain).connect(master);
    osc.start(start);
    osc.stop(start + 0.4);
  }
}
