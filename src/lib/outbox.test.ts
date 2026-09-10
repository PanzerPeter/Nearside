import { describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS,
  belongsTo,
  clearFor,
  enqueue,
  isAttemptable,
  isDuplicateSend,
  nextDelayMs,
} from './outbox';
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

describe('belongsTo', () => {
  // The store is one database per device while everything in it is per account,
  // so this is the whole of the scoping. `listFor` and `clearFor` share it
  // rather than each writing the comparison out: they disagreed once, and the
  // shape of the bug was one account's sign-out silently discarding another
  // account's unsent messages.
  it('matches only the account that queued the message', () => {
    const mine = samplePending({ user_id: 'me' });
    expect(belongsTo(mine, 'me')).toBe(true);
    expect(belongsTo(mine, 'someone-else')).toBe(false);
  });

  it('does not confuse the sender with the recipient', () => {
    // A message I sent to you belongs to me. Scoping on `receiver_id` — the
    // one field the store actually indexes — would clear it from your queue.
    const mine = samplePending({ user_id: 'me', receiver_id: 'friend' });
    expect(belongsTo(mine, 'friend')).toBe(false);
  });
});

describe('clearFor', () => {
  // Same condition as `enqueue` above: no `indexedDB` in this environment. The
  // contract is that a sign-out is never blocked by storage that isn't there.
  it('resolves rather than throwing when IndexedDB is unavailable', async () => {
    await expect(clearFor('me')).resolves.toBeUndefined();
  });
});

describe('isAttemptable', () => {
  it('attempts an ordinary queued message', () => {
    expect(isAttemptable(samplePending())).toBe(true);
  });

  it('attempts one that has failed some attempts but not all of them', () => {
    expect(isAttemptable(samplePending({ attempts: MAX_ATTEMPTS - 1 }))).toBe(true);
  });

  it('leaves a failed message alone', () => {
    // Not the same question as "has it used its attempts": the mark is what
    // the flush loop reads, so that a queue holding a failed message does not
    // spin against whatever refused it every time the app wakes. Waking is
    // frequent — every screen-on bumps the generation — and the next attempt
    // is the user's decision, made on the bubble.
    expect(isAttemptable(samplePending({ attempts: MAX_ATTEMPTS, failed: true }))).toBe(false);
  });

  it('treats a row written before the mark existed as attemptable', () => {
    // `failed` is optional, so entries queued by an older build come back with
    // it undefined. Reading that as "failed" would strand every one of them.
    const legacy = samplePending();
    delete (legacy as { failed?: boolean }).failed;
    expect(isAttemptable(legacy)).toBe(true);
  });
});
