// Running the same job over a list without doing all of it at once.
//
// Written for the sticker drawer, which is the one place in the app that turns
// a single tap into a hundred requests: opening the picker fetches and
// decrypts every sticker in the library, and Storage downloads are deliberately
// outside the read queue in `net-queue.ts` (a 50 MB video must not hold a slot
// with every query in the app behind it). Unbounded, that is a hundred parallel
// GETs against a phone link, issued at the exact moment the emoji panel is
// loading half a megabyte of its own — the tiles all arrive late together
// instead of the first row arriving at once.

/**
 * Run `task` over `items`, at most `limit` at a time, in order.
 *
 * A task that throws is dropped rather than aborting the rest: one sticker
 * whose bytes will not come back would otherwise leave every tile behind it
 * blank. `cancelled` is polled between tasks so a picker that closes mid-load
 * stops handing out work it no longer has anywhere to put.
 */
export async function mapWithLimit<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<unknown>,
  cancelled?: () => boolean
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (cancelled?.()) return;
      const item = items[next++];
      try {
        await task(item);
      } catch {
        // See above: one failure is one blank tile, not a blank drawer.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
