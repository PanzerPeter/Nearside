import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_CONCURRENT_READS,
  readsInFlight,
  resetReadQueueForTest,
  RETRY_BASE_MS,
  retryDelayMs,
  withReadSlot,
  worthAttempting,
} from './net-queue';

afterEach(resetReadQueueForTest);

describe('retryDelayMs', () => {
  it('doubles the window each attempt', () => {
    // Random 1 would be the top of the window; the highest a given attempt can
    // wait is what shows the doubling.
    expect(retryDelayMs(0, 0.999)).toBeLessThanOrEqual(RETRY_BASE_MS);
    expect(retryDelayMs(1, 0.999)).toBeLessThanOrEqual(RETRY_BASE_MS * 2);
    expect(retryDelayMs(2, 0.999)).toBeLessThanOrEqual(RETRY_BASE_MS * 4);
  });

  it('spreads across the whole window, so retries that failed together separate', () => {
    // The failure being avoided: a fixed backoff schedules every request in a
    // wake stampede for the same instant twice.
    expect(retryDelayMs(2, 0)).toBe(0);
    expect(retryDelayMs(2, 0.5)).toBe(RETRY_BASE_MS * 2);
  });

  it('never asks anyone to wait a negative time', () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(retryDelayMs(attempt, 0)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('worthAttempting', () => {
  it('refuses a read on a device that says it has no network', () => {
    expect(worthAttempting(false)).toBe(false);
  });

  it('allows one when the device says it does', () => {
    expect(worthAttempting(true)).toBe(true);
  });

  it('allows one when the platform cannot say, rather than refusing forever', () => {
    expect(worthAttempting(undefined)).toBe(true);
  });
});

describe('withReadSlot', () => {
  /** A task that finishes only when its returned `release` is called. */
  function held() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { run: () => gate, release };
  }

  it('runs a read straight through when nothing is in flight', async () => {
    expect(await withReadSlot(async () => 'answer')).toBe('answer');
  });

  it('never lets more than the cap run at once', async () => {
    const tasks = Array.from({ length: MAX_CONCURRENT_READS + 4 }, held);
    const runs = tasks.map((t) => withReadSlot(t.run));

    // Let the scheduler place everything it is going to place.
    await Promise.resolve();
    await Promise.resolve();
    expect(readsInFlight()).toBe(MAX_CONCURRENT_READS);

    for (const t of tasks) t.release();
    await Promise.all(runs);
    expect(readsInFlight()).toBe(0);
  });

  it('lets a queued read through as soon as one finishes', async () => {
    const tasks = Array.from({ length: MAX_CONCURRENT_READS }, held);
    const runs = tasks.map((t) => withReadSlot(t.run));
    let queuedRan = false;
    const queued = withReadSlot(async () => {
      queuedRan = true;
    });

    await Promise.resolve();
    expect(queuedRan).toBe(false);

    tasks[0].release();
    await runs[0];
    await queued;
    expect(queuedRan).toBe(true);

    for (const t of tasks) t.release();
    await Promise.all(runs);
  });

  it('releases the slot when the read throws', async () => {
    // Six leaked slots would stop the app reading anything, silently and for
    // good — a worse failure than the congestion the cap exists to fix.
    await expect(
      withReadSlot(async () => {
        throw new Error('network');
      })
    ).rejects.toThrow('network');
    expect(readsInFlight()).toBe(0);
  });

  it('serves the longest-waiting read first', async () => {
    const tasks = Array.from({ length: MAX_CONCURRENT_READS }, held);
    const runs = tasks.map((t) => withReadSlot(t.run));
    const order: string[] = [];
    const first = withReadSlot(async () => {
      order.push('first');
    });
    const second = withReadSlot(async () => {
      order.push('second');
    });

    for (const t of tasks) t.release();
    await Promise.all([...runs, first, second]);
    expect(order).toEqual(['first', 'second']);
  });
});
