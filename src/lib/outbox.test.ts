import { describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, enqueue, isDuplicateSend, nextDelayMs } from './outbox';
import { PendingMessage } from './types';

function samplePending(overrides: Partial<PendingMessage> = {}): PendingMessage {
  return {
    id: 'msg-1',
    user_id: 'me',
    receiver_id: 'friend',
    text: 'hello',
    reply_to_id: null,
    created_at: new Date().toISOString(),
    attempts: 0,
    ...overrides,
  };
}

describe('enqueue', () => {
  // This suite runs in vitest's `node` environment, which has no
  // `indexedDB` global — the same condition a private-browsing tab with
  // storage denied produces in a real browser. `enqueue` resolving `false`
  // here is exactly the signal `useOutbox.send` needs to fall back to a
  // direct send instead of leaving the message queued forever with nowhere
  // that will ever pick it up (see Finding 2 in the task-7 review).
  it('resolves false when IndexedDB is unavailable, so the caller can fall back to a direct send', async () => {
    const persisted = await enqueue(samplePending());
    expect(persisted).toBe(false);
  });
});

describe('nextDelayMs', () => {
  it('starts at one second', () => {
    expect(nextDelayMs(0)).toBe(1000);
  });

  it('doubles with each attempt', () => {
    expect(nextDelayMs(1)).toBe(2000);
    expect(nextDelayMs(2)).toBe(4000);
    expect(nextDelayMs(3)).toBe(8000);
  });

  it('caps so a long offline stretch does not stall the queue', () => {
    expect(nextDelayMs(10)).toBe(30_000);
    expect(nextDelayMs(100)).toBe(30_000);
  });

  it('gives up after a bounded number of attempts', () => {
    expect(MAX_ATTEMPTS).toBe(5);
  });
});

describe('isDuplicateSend', () => {
  // A queued message sends its own uuid as the row's primary key, so a retry
  // of a send whose response never came back collides instead of writing a
  // second copy. Recognising the collision is what turns "the message was
  // already delivered" into a success rather than another retry — the
  // mechanism that stops a flaky connection from sending a message twice.
  it('recognises the unique-violation SQLSTATE', () => {
    expect(isDuplicateSend({ code: '23505', message: 'duplicate key value' })).toBe(true);
  });

  it('falls back to the message when no SQLSTATE is attached', () => {
    expect(
      isDuplicateSend({
        message: 'duplicate key value violates unique constraint "messages_pkey"',
      })
    ).toBe(true);
  });

  it('does not mistake other failures for an already-delivered message', () => {
    expect(isDuplicateSend(null)).toBe(false);
    expect(isDuplicateSend({ code: '23503', message: 'foreign key violation' })).toBe(false);
    expect(isDuplicateSend({ message: 'rate_limited_messages' })).toBe(false);
    expect(isDuplicateSend({})).toBe(false);
  });
});
