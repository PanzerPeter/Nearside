// How often an arriving message is allowed to make a noise.
//
// A conversation is a burst of short messages, and a sound for each of them is
// a phone buzzing six times while somebody finishes a sentence. The first fix
// for that was one sound per sender per thirty seconds, which traded the buzzing
// for the opposite failure: a phone in a pocket reported a six-message burst as
// a single chime, and spent its next sound half a minute later, when the burst
// was over and the useful moment had passed.
//
// The rule here is a ladder instead of a flat window. The first message rings
// at once, the second five seconds later, the third fifteen after that, and
// everything beyond settles at forty seconds. A conversation you are not
// watching therefore announces itself two or three times while it is actually
// happening, then stops competing for your attention — which is what people
// mean when they say the phone should tell them something arrived without
// buzzing all afternoon.
//
// The ladder resets on two things, and the first is the one a cooldown alone
// cannot see:
//
//   - you caught up. Once the receiver's read watermark passes the message we
//     last rang about, the next thing they send is a new turn rather than the
//     tail of a burst, and it rings like a first message. Without this, reading
//     a chat and putting the phone down bought thirty seconds of silence for a
//     reply that had every right to be heard.
//   - a long silence. Five minutes with nothing said is the end of the burst
//     whether or not anybody read anything.
//
// The same rule runs in two places that cannot share code — here for the
// in-app chime on desktop and in the browser, and in `send-push` for the
// notification a phone raises while the app is closed. The Edge Function is
// Deno and cannot import from `src/`, so the ladder is stated there a second
// time with a comment pointing back here. If one moves, move both.
//
// Per sender (per room, on the server's room path) rather than per account:
// Alice mid-burst must not silence the first thing Bob says, and the two
// conversations are separate entries in the shade anyway.

/**
 * The wait before each successive alert, indexed by how many times we have
 * already rung without the conversation being caught up.
 *
 * The last rung is the resting state: an unread conversation that keeps
 * talking gets one sound every forty seconds, indefinitely.
 */
export const ALERT_LADDER_MS = [0, 5_000, 15_000, 40_000] as const;

/**
 * Silence long enough that the next message starts the ladder over.
 *
 * Deliberately longer than the last rung: a conversation still trickling in at
 * one message a minute is the same burst, and must not have its budget
 * refilled by every gap between sentences.
 */
export const ALERT_IDLE_RESET_MS = 5 * 60_000;

/** When this conversation last made a noise, and how many times in a row. */
export interface AlertAnchor {
  alertedAt: number;
  /** Alerts since the last reset, clamped to the ladder's length. */
  streak: number;
}

export interface AlertDecision {
  alerting: boolean;
  /** The streak to store — meaningful only when `alerting`. */
  streak: number;
}

/** How long after alert number `streak` the next one may sound. */
export function requiredGapMs(streak: number): number {
  if (streak <= 0) return 0;
  return ALERT_LADDER_MS[Math.min(streak, ALERT_LADDER_MS.length - 1)];
}

/**
 * Whether a message arriving at `now` should make a sound.
 *
 * `readAt` is the receiver's read watermark for this conversation, or null when
 * the caller has none — the in-app path tracks being caught up by dropping the
 * anchor outright (`clearAlert`), and only the server has a stored watermark to
 * compare against.
 *
 * A future anchor rings and starts over: the clock can go backwards (a wake
 * with a corrected time, an NTP answer arriving late), and a rule that only
 * counted forwards would strand the anchor and silence that conversation
 * permanently.
 */
export function decideAlert(
  anchor: AlertAnchor | null,
  now: number,
  readAt: number | null
): AlertDecision {
  if (!anchor || !Number.isFinite(anchor.alertedAt)) {
    return { alerting: true, streak: 1 };
  }

  const caughtUp = readAt !== null && readAt >= anchor.alertedAt;
  const idle = now - anchor.alertedAt >= ALERT_IDLE_RESET_MS;
  const clockWentBack = now < anchor.alertedAt;
  if (caughtUp || idle || clockWentBack) return { alerting: true, streak: 1 };

  if (now - anchor.alertedAt < requiredGapMs(anchor.streak)) {
    return { alerting: false, streak: anchor.streak };
  }
  return {
    alerting: true,
    streak: Math.min(anchor.streak + 1, ALERT_LADDER_MS.length),
  };
}

/**
 * The decision plus the bookkeeping, over a map of anchors held by the caller.
 *
 * The anchor moves only when we alert. Stamping it on every message instead
 * would make the window slide with the conversation, so anyone typing just
 * inside the gap would never be heard again — the failure this whole module
 * exists to avoid.
 */
export function noteAlert(
  anchors: Map<string, AlertAnchor>,
  key: string,
  now: number
): boolean {
  const decision = decideAlert(anchors.get(key) ?? null, now, null);
  if (decision.alerting) anchors.set(key, { alertedAt: now, streak: decision.streak });
  return decision.alerting;
}

/**
 * Forget a conversation's streak, because it has been looked at.
 *
 * The local half of the read reset: opening a chat means the next thing that
 * arrives while you are elsewhere is a first message again.
 */
export function clearAlert(anchors: Map<string, AlertAnchor>, key: string): void {
  anchors.delete(key);
}
