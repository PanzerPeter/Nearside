// How often an arriving message is allowed to make a noise.
//
// A conversation is a burst of short messages, and a notification for each of
// them is a phone buzzing six times while somebody finishes a sentence. What
// every other messenger does is alert on the first and let the rest land
// quietly: the notification still appears, the count still rises, the sound
// does not repeat. This is that rule, and it is nothing more than a comparison
// against the last time we alerted.
//
// The same rule runs in two places that cannot share code — here for the
// in-app chime on desktop and in the browser, and in `send-push` for the
// notification a phone raises while the app is closed. The Edge Function is
// Deno and cannot import from `src/`, so `ALERT_COOLDOWN_MS` is stated there a
// second time with a comment pointing back here. If one moves, move both.
//
// Per sender rather than per account: Alice mid-burst must not silence the
// first thing Bob says, and the two conversations are separate entries in the
// shade anyway.

/**
 * How long after an alert the same sender stays quiet.
 *
 * Thirty seconds rather than a few: at ten a fast back-and-forth still buzzes
 * six times a minute, which is the complaint rather than the fix. Long enough
 * to cover a burst, short enough that a genuinely new message half a minute
 * later still announces itself.
 */
export const ALERT_COOLDOWN_MS = 30_000;

/**
 * Whether a message arriving at `now` should make a sound, given when this
 * sender last did.
 *
 * `null` means never. A future anchor also alerts: the clock can go backwards
 * (a wake with a corrected time, an NTP answer arriving late), and a rule that
 * only counted forwards would strand the anchor and silence that conversation
 * permanently.
 */
export function shouldAlert(
  lastAlertAt: number | null,
  now: number,
  cooldownMs: number = ALERT_COOLDOWN_MS
): boolean {
  if (lastAlertAt === null) return true;
  return now < lastAlertAt || now - lastAlertAt >= cooldownMs;
}

/**
 * The decision plus the bookkeeping, over a map of anchors held by the caller.
 *
 * The anchor moves only when we alert. Stamping it on every message instead
 * would make the window slide with the conversation, so anyone typing just
 * inside the cooldown would never be heard again — the failure this whole
 * module exists to avoid.
 */
export function noteAlert(
  anchors: Map<string, number>,
  senderId: string,
  now: number,
  cooldownMs: number = ALERT_COOLDOWN_MS
): boolean {
  const alerting = shouldAlert(anchors.get(senderId) ?? null, now, cooldownMs);
  if (alerting) anchors.set(senderId, now);
  return alerting;
}
