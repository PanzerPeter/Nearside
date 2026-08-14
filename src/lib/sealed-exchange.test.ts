import { describe, expect, it } from 'vitest';
import { exchangeState, openAnswer, splitAnswers, type OpenedAnswer } from './sealed-exchange';
import { identityFromSeed } from './crypto/keys';
import { generateMnemonic, seedFromMnemonic } from './crypto/mnemonic';
import { sealBody } from './sealed-body';

const ME = '00000000-0000-0000-0000-00000000000a';
const PEER = '00000000-0000-0000-0000-00000000000b';

function answer(user_id: string, text: string | null): OpenedAnswer {
  return {
    id: `${user_id}-answer`,
    prompt_id: 'prompt',
    user_id,
    text,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

async function identity() {
  return identityFromSeed(await seedFromMnemonic(generateMnemonic()));
}

describe('exchangeState', () => {
  it('waits on you until you have answered', () => {
    expect(exchangeState(ME, [])).toBe('awaiting_you');
  });

  // The policy withholds the peer's row until yours exists, so a client that
  // has not answered cannot tell whether they have. Asserted because a future
  // reader might "fix" this branch into reporting their progress, which would
  // leak exactly the ordering the feature exists to remove.
  it('still waits on you when only the peer has answered', () => {
    expect(exchangeState(ME, [answer(PEER, 'theirs')])).toBe('awaiting_you');
  });

  it('waits on the peer once yours is committed', () => {
    expect(exchangeState(ME, [answer(ME, 'mine')])).toBe('awaiting_peer');
  });

  it('reveals when both are in', () => {
    expect(exchangeState(ME, [answer(ME, 'mine'), answer(PEER, 'theirs')])).toBe('revealed');
  });

  // A row that failed to decrypt is still a commitment: it is present, so the
  // exchange is over, and the card has to render the failure rather than sit
  // on "waiting" forever.
  it('reveals even when the peer answer cannot be opened', () => {
    expect(exchangeState(ME, [answer(ME, 'mine'), answer(PEER, null)])).toBe('revealed');
  });
});

describe('splitAnswers', () => {
  it('puts each side in a fixed slot regardless of arrival order', () => {
    const { mine, theirs } = splitAnswers(ME, [answer(PEER, 'theirs'), answer(ME, 'mine')]);
    expect(mine?.text).toBe('mine');
    expect(theirs?.text).toBe('theirs');
  });
});

describe('answers on the wire', () => {
  // The sibling of no-plaintext.test.ts. An answer is a message body by another
  // name, and the whole feature is worthless if the row the server refuses to
  // release is readable by the server holding it.
  it('never puts an answer into an insert payload', async () => {
    const me = await identity();
    const them = await identity();
    const secret = 'the number I would actually accept is forty';

    const sealed = await sealBody(me, them.boxPublic, ME, PEER, secret);
    const serialized = JSON.stringify(sealed);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('forty');
    expect(Object.keys(sealed).sort()).toEqual(['ciphertext', 'nonce']);
  });

  // Either participant opens either answer: the box is mutual, and the row
  // carries only its author, so `openAnswer` reconstructs the counterpart.
  it('opens the asker’s own answer as well as the peer’s', async () => {
    const me = await identity();
    const them = await identity();
    const secret = 'mine, sealed to them';

    const sealed = await sealBody(me, them.boxPublic, ME, PEER, secret);
    const row = {
      id: 'a1',
      prompt_id: 'p1',
      user_id: ME,
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect((await openAnswer(me, them.boxPublic, ME, PEER, row)).text).toBe(secret);
    expect((await openAnswer(them, me.boxPublic, PEER, ME, row)).text).toBe(secret);
  });

  it('reports an unopenable answer as null rather than throwing', async () => {
    const me = await identity();
    const them = await identity();
    const stranger = await identity();
    const sealed = await sealBody(me, them.boxPublic, ME, PEER, 'not for you');

    const opened = await openAnswer(stranger, stranger.boxPublic, ME, PEER, {
      id: 'a1',
      prompt_id: 'p1',
      user_id: ME,
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect(opened.text).toBeNull();
  });
});
