import { describe, expect, it } from 'vitest';
import { mapWithLimit } from './pool';

/** A task that resolves when it is told to, so a test can hold the pool open. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('mapWithLimit', () => {
  it('runs every item', async () => {
    const seen: number[] = [];
    await mapWithLimit([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('never has more than the limit in flight', async () => {
    let running = 0;
    let peak = 0;
    const gates = [gate(), gate(), gate(), gate()];
    const done = mapWithLimit([0, 1, 2, 3], 2, async (i) => {
      running += 1;
      peak = Math.max(peak, running);
      await gates[i].promise;
      running -= 1;
    });
    await Promise.resolve();
    expect(peak).toBe(2);
    gates.forEach((g) => g.release());
    await done;
    expect(peak).toBe(2);
  });

  it('keeps going when one task throws', async () => {
    // One sticker whose bytes will not come back must not strand the rest of
    // the drawer as blank tiles.
    const done: number[] = [];
    await mapWithLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('no');
      done.push(n);
    });
    expect(done.sort()).toEqual([1, 3]);
  });

  it('stops starting work once the caller has given up', async () => {
    // The picker closes mid-load: whatever has not started must not start.
    const started: number[] = [];
    let cancelled = false;
    const done = mapWithLimit(
      [1, 2, 3, 4],
      1,
      async (n) => {
        started.push(n);
        cancelled = true;
      },
      () => cancelled
    );
    await done;
    expect(started).toEqual([1]);
  });
});
