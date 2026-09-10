// How many reads the app is allowed to have in flight, and how long it waits
// before trying one again.
//
// Both exist because of the same moment. `lib/connection.ts` bumps a
// generation on every wake, and every subscriber in the app keys its effect on
// that number — so a phone coming out of a pocket issues the profile read, the
// conversation list, the pending requests, the open thread's page, its
// receipts, its reactions, the sealed exchange and the room list at once,
// against whatever connection just came back. On a good link that is fine and
// invisible. On a weak one they compete, all of them crawl, and they reach the
// 25-second timeout together — at which point the retry doubles the pile.
//
// A queue turns that stampede back into a series. The same requests are made,
// in the same order, and the early ones get the whole link instead of a
// fraction of it, so the conversation the user is actually looking at paints
// while the rest wait their turn. Nothing is dropped and nothing is
// prioritised: reordering would mean guessing which read the user is waiting
// for, and the guess would be wrong about as often as it was right.
//
// Kept out of `supabase.ts` so the policy is testable without a fetch.

/**
 * Reads allowed in flight at once.
 *
 * Six, matching what a browser would give a single HTTP/1.1 origin anyway — so
 * on a fast connection this changes nothing at all, which is the point. It
 * only bites when there are more requests than the link can carry, which is
 * exactly the case worth changing.
 *
 * Storage downloads are deliberately not counted: they are excluded from this
 * path entirely (see `isStorageObject`), because a 50 MB video holding a slot
 * for a minute would starve the queries behind it.
 */
export const MAX_CONCURRENT_READS = 6;

/** First wait before a dropped read is tried again. */
export const RETRY_BASE_MS = 300;

/**
 * How long to wait before attempt number `attempt` (0-based), given a random
 * number in [0, 1).
 *
 * Doubling, with the wait spread across a window rather than landing on a
 * fixed instant. The jitter is not decoration: the requests being retried are
 * the ones that failed *together*, in the wake stampede above, so a fixed
 * backoff schedules their second attempt for the same millisecond as well —
 * rebuilding the pile that caused the failure, one rung further down the
 * doubling.
 *
 * The spread is full — anywhere from nothing to the whole window — rather than
 * a small wobble around the target. A narrow jitter still leaves the retries
 * clustered; what breaks up a herd is a wide one.
 */
export function retryDelayMs(attempt: number, random: number): number {
  const window = RETRY_BASE_MS * 2 ** attempt;
  return Math.round(window * random);
}

/**
 * Whether attempting a read is worth anything right now.
 *
 * A device that says it has no network will fail the request in microseconds
 * and count an attempt for it, so a burst of retries against a phone in a
 * tunnel exhausts the budget before it has been out of the tunnel for a
 * moment. The read is refused instead, and the caller's own recovery — the
 * wake generation, the poll, the outbox's `online` listener — is what tries
 * again when there is something to try against.
 *
 * `!== false` rather than a truthiness test, for the reason `connection.ts`
 * uses the same shape: an environment exposing `navigator` without `onLine`
 * yields undefined, and reading that as "offline" would refuse every read
 * forever.
 */
export function worthAttempting(online: boolean | undefined): boolean {
  return online !== false;
}

let inFlight = 0;
const waiting: (() => void)[] = [];

/**
 * Run `task` when a slot is free, and release the slot afterwards.
 *
 * The release is in a `finally`, which is what keeps a thrown request from
 * leaking a slot — six of those and the app stops reading anything, silently
 * and permanently, which is a far worse failure than the congestion this
 * exists to fix.
 */
export async function withReadSlot<T>(task: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_CONCURRENT_READS) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  inFlight += 1;
  try {
    return await task();
  } finally {
    inFlight -= 1;
    // Shift, not pop: the queue is first-in-first-out, so a read that has been
    // waiting longest goes next. A stack would let a steady trickle of new
    // requests starve whatever arrived first.
    waiting.shift()?.();
  }
}

/** In flight right now. Exported for the tests, which have no other way to see
 *  that the cap is doing anything. */
export function readsInFlight(): number {
  return inFlight;
}

/** Drop the queue. Tests only — a real run has no reason to abandon reads
 *  somebody is waiting on. */
export function resetReadQueueForTest(): void {
  inFlight = 0;
  waiting.length = 0;
}
