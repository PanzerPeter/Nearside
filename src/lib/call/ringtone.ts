// The two tones a call makes before it connects, synthesized rather than
// shipped — the same choice `lib/sound.ts` makes, and for the same reason: no
// binary asset, nothing to license, nothing to decode.
//
// Deliberately not gated on the message-chime mute in `lib/sound.ts`. Silencing
// notification chimes is a statement about messages; someone who did that has
// not asked for their phone to stay silent when a friend calls them. On Android
// the notification channel's own ringtone covers the case where the app is not
// in the foreground, so this is the in-app half — and its own switch, below, is
// what someone who wants calls to arrive quietly reaches for instead.

import { sharedAudioContext } from '../sound';

/** Separate from `nearside.sound.muted` for the reason above: the two are
 *  different statements and one key could only express one of them. */
const RING_MUTE_KEY = 'nearside.call.ringtone.muted';

/** Incoming: a two-note figure, repeating with a gap, like a phone ringing. */
const RING_PERIOD_MS = 3_000;
/** Outgoing: the single low tone a network plays back while the far end rings. */
const RINGBACK_PERIOD_MS = 4_000;

let timer: ReturnType<typeof setInterval> | null = null;
/** Oscillators currently sounding, so a stop mid-figure leaves nothing hanging. */
let voices: OscillatorNode[] = [];

interface Note {
  freq: number;
  /** Seconds from the start of the figure. */
  at: number;
  seconds: number;
  gain: number;
}

const RING: Note[] = [
  { freq: 660, at: 0, seconds: 0.4, gain: 0.16 },
  { freq: 880, at: 0.45, seconds: 0.4, gain: 0.16 },
];

const RINGBACK: Note[] = [{ freq: 440, at: 0, seconds: 1.0, gain: 0.07 }];

function playFigure(notes: Note[]): void {
  const ctx = sharedAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  for (const note of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = note.freq;

    const start = now + note.at;
    const end = start + note.seconds;
    // Ramped, never stepped. A square-edged gain change on a sine is an
    // audible click, and a click every three seconds is worse than no ring.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(note.gain, start + 0.04);
    gain.gain.setValueAtTime(note.gain, end - 0.06);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(end);
    osc.onended = () => {
      voices = voices.filter((v) => v !== osc);
    };
    voices.push(osc);
  }
}

function loop(notes: Note[], periodMs: number): void {
  stopRinging();
  playFigure(notes);
  timer = setInterval(() => playFigure(notes), periodMs);
}

export function isRingtoneMuted(): boolean {
  try {
    return localStorage.getItem(RING_MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setRingtoneMuted(muted: boolean): void {
  try {
    localStorage.setItem(RING_MUTE_KEY, muted ? '1' : '0');
  } catch {
    /* ignore storage failures */
  }
}

/**
 * The phone ringing, for an incoming call.
 *
 * Read at ring time rather than captured once: the switch is two taps away in
 * settings and a value cached at import would go on ringing for the rest of the
 * session after someone turned it off.
 */
export function startRingtone(): void {
  if (isRingtoneMuted()) return;
  loop(RING, RING_PERIOD_MS);
}

/**
 * The tone the caller hears while the far end rings.
 *
 * Not covered by the switch above. That one silences a call arriving; this is
 * feedback for a call you just placed, and someone who dialled is waiting to
 * hear something.
 */
export function startRingback(): void {
  loop(RINGBACK, RINGBACK_PERIOD_MS);
}

/**
 * Silence, immediately.
 *
 * Stops the sounding oscillators as well as the loop. Clearing only the
 * interval would leave the current figure playing for up to a second after the
 * call is answered, so the first thing each person hears is the other's voice
 * under a ringtone.
 */
export function stopRinging(): void {
  if (timer) clearInterval(timer);
  timer = null;
  for (const osc of voices) {
    try {
      osc.stop();
    } catch {
      /* already stopped */
    }
  }
  voices = [];
}
