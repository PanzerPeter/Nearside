// Capture that starts before the call needs it.
//
// `getUserMedia` on a cold Android WebView is the slowest step in answering a
// call — the microphone alone is a good fraction of a second, a camera more —
// and it sits in the middle of the answer path, after the offer has arrived and
// before the answer can be built. On the lock-screen path there is a stretch of
// time before that where the phone has nothing to do but wait for the caller's
// next offer, which is exactly long enough to have opened the microphone.
//
// **Only ever primed once the user has answered.** The trade this makes is
// opening the microphone slightly before the call is negotiated, and it is only
// acceptable because the decision has already been taken — the tap on Answer
// happened on the lock screen and the app is booting because of it. Nothing here
// is called while a phone is merely ringing: a capture started on a ring the
// user has not accepted is an app that listens to a room nobody agreed to.
//
// The capture device is injected rather than reached for, like `session.ts`, so
// the handover rules are testable in the node suite with no WebRTC present.

import { mediaConstraints } from './session';
import type { CallKind } from './types';

type GetMedia = (constraints: MediaStreamConstraints) => Promise<MediaStream>;

interface Warm {
  kind: CallKind;
  capture: Promise<MediaStream>;
}

let warm: Warm | null = null;

/**
 * Start capturing for a call that is about to be answered.
 *
 * A second call for the same kind is a no-op — two captures would mean two
 * microphones, and Android shows the indicator for both.
 */
export function primeMedia(kind: CallKind, getMedia: GetMedia): void {
  if (warm?.kind === kind) return;
  releaseWarmMedia();
  const capture = getMedia(mediaConstraints(kind));
  // Nothing awaits this until the call claims it, and a denied permission would
  // otherwise surface as an unhandled rejection seconds before anything is
  // ready to report it. The claim path sees the rejection and falls back.
  capture.catch(() => {});
  warm = { kind, capture };
}

/**
 * Park a capture that has already happened.
 *
 * The dialling side's use: it captures first, because that is the step the user
 * can refuse and nobody's phone should ring for a call that a denied microphone
 * is about to end. Parking the result here lets the ring go out *next*, in
 * parallel with minting TURN credentials and building the offer, instead of
 * after them — a second of the far phone's head start, and it is the phone that
 * has to boot.
 */
export function holdWarmMedia(kind: CallKind, stream: MediaStream): void {
  releaseWarmMedia();
  warm = { kind, capture: Promise.resolve(stream) };
}

/**
 * Hand the primed capture to the call, once.
 *
 * Null means capture normally: nothing was primed, or the call turned out to be
 * a different kind from the one guessed by the notification — in which case what
 * was primed is released here rather than left holding the camera for the length
 * of the call.
 */
export function takeWarmMedia(kind: CallKind): Promise<MediaStream> | null {
  if (!warm) return null;
  if (warm.kind !== kind) {
    releaseWarmMedia();
    return null;
  }
  const { capture } = warm;
  warm = null;
  return capture;
}

/**
 * Give the hardware back.
 *
 * Called from the provider's teardown, which runs for every call however it
 * ended — including one that was answered on the lock screen and then cancelled
 * by the caller before an offer ever arrived. Without it that phone keeps the
 * microphone indicator lit with no call behind it.
 */
export function releaseWarmMedia(): void {
  const held = warm;
  warm = null;
  if (!held) return;
  void held.capture.then(
    (stream) => {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* already stopped */
        }
      }
    },
    () => {
      /* never opened; nothing to release */
    }
  );
}
