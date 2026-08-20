import { describe, expect, it } from 'vitest';
import { SELF_CHAT_LABEL } from './conversation';
import sodium from 'libsodium-wrappers';
import {
  MAX_NICKNAME_LENGTH,
  formatDisplayName,
  isPlaintextRow,
  nicknameFor,
  nicknameMapFrom,
  normalizeNickname,
  openNicknames,
  resetNicknames,
  subscribeNicknames,
  type NicknameRow,
} from './nicknames';
import { sealForSelf } from './crypto/seal';

const ME = '00000000-0000-0000-0000-00000000000a';
const PEER = '00000000-0000-0000-0000-00000000000b';
const OTHER = '00000000-0000-0000-0000-00000000000c';

/** An opened row, which is what `nicknameMapFrom` works in. */
function row(peerId: string, nickname: string) {
  return { peer_id: peerId, nickname };
}

/** A row as it was written before 0041: plaintext, no seal. */
function plaintextRow(peerId: string, nickname: string): NicknameRow {
  return {
    owner_id: ME,
    peer_id: peerId,
    nickname,
    nickname_ciphertext: null,
    nickname_nonce: null,
  };
}

describe('normalizeNickname', () => {
  it('keeps an ordinary nickname as typed', () => {
    expect(normalizeNickname('Bobby')).toBe('Bobby');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeNickname('  Bobby  ')).toBe('Bobby');
  });

  it('treats a blank or whitespace-only value as no nickname', () => {
    expect(normalizeNickname('')).toBeNull();
    expect(normalizeNickname('   ')).toBeNull();
  });

  it('rejects a value that is only control characters', () => {
    // Would otherwise reach the nickname_length CHECK as a non-empty string
    // that renders as a blank name.
    expect(normalizeNickname('\n\t')).toBeNull();
  });

  it('flattens control characters instead of rendering a broken line', () => {
    // The sidebar and chat header paint the nickname on one line, and the
    // nickname_single_line CHECK in 0016 refuses anything else.
    expect(normalizeNickname('Bob\nby')).toBe('Bob by');
    expect(normalizeNickname('Bob\tby')).toBe('Bob by');
  });

  it('truncates a pasted over-long value to the column limit', () => {
    const long = 'x'.repeat(MAX_NICKNAME_LENGTH + 10);
    expect(normalizeNickname(long)).toHaveLength(MAX_NICKNAME_LENGTH);
  });

  it('does not leave trailing whitespace after truncating mid-space', () => {
    // Slicing can land on a space, which would otherwise be stored — the
    // column measures its length after trimming, so the two must agree.
    const value = `${'x'.repeat(MAX_NICKNAME_LENGTH - 1)} yyy`;
    expect(normalizeNickname(value)).toBe('x'.repeat(MAX_NICKNAME_LENGTH - 1));
  });
});

describe('formatDisplayName', () => {
  it('prefers the nickname when there is one', () => {
    expect(formatDisplayName('Bobby', 'bob')).toBe('Bobby');
  });

  it('falls back to the bare display name with no nickname', () => {
    // No `@`: it read as a handle you could look somebody up by, and there has
    // been nothing to look anybody up in since the directory went. Asserted
    // rather than left implicit, so putting the sigil back is a failing test.
    expect(formatDisplayName(null, 'bob')).toBe('bob');
    expect(formatDisplayName(undefined, 'bob')).toBe('bob');
  });

  it('treats a whitespace-only nickname as absent', () => {
    expect(formatDisplayName('   ', 'bob')).toBe('bob');
  });

  it('degrades to a placeholder when neither is known', () => {
    // A conversation row can be in hand before its profile read lands;
    // "undefined" on a chat header would be worse than saying nothing.
    expect(formatDisplayName(null, null)).toBe('unknown');
  });

  it('names the self-chat rather than showing your own handle back to you', () => {
    expect(formatDisplayName(null, 'me', true)).toBe(SELF_CHAT_LABEL);
  });

  it('lets a nickname override the self-chat label', () => {
    expect(formatDisplayName('Scratchpad', 'me', true)).toBe('Scratchpad');
  });
});

describe('nicknameMapFrom', () => {
  it('keys the map by peer, not by owner', () => {
    const map = nicknameMapFrom([row(PEER, 'Bobby'), row(OTHER, 'Caz')]);
    expect(map.get(PEER)).toBe('Bobby');
    expect(map.get(OTHER)).toBe('Caz');
    expect(map.has(ME)).toBe(false);
  });

  it('keeps the self row, which is the self-chat nickname', () => {
    expect(nicknameMapFrom([row(ME, 'My notes')]).get(ME)).toBe('My notes');
  });

  it('drops a row whose nickname is unusable rather than showing a blank name', () => {
    expect(nicknameMapFrom([row(PEER, '   ')]).size).toBe(0);
  });

  it('normalizes on read too, so an older row cannot break the line', () => {
    expect(nicknameMapFrom([row(PEER, ' Bob\nby ')]).get(PEER)).toBe('Bob by');
  });

  it('is empty for no rows', () => {
    expect(nicknameMapFrom([]).size).toBe(0);
  });
});

describe('openNicknames', () => {
  it('opens a sealed row', async () => {
    await sodium.ready;
    const vaultKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const sealed = await sealForSelf(vaultKey, 'Bobby');
    const rows: NicknameRow[] = [
      {
        owner_id: ME,
        peer_id: PEER,
        nickname: null,
        nickname_ciphertext: sealed.ciphertext,
        nickname_nonce: sealed.nonce,
      },
    ];
    expect(await openNicknames(vaultKey, rows)).toEqual([{ peer_id: PEER, nickname: 'Bobby' }]);
  });

  it('still reads a row written before 0041', async () => {
    await sodium.ready;
    const vaultKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    // The migration is backwards compatible on purpose: a nickname set on an
    // older build keeps rendering until the device re-seals it.
    expect(await openNicknames(vaultKey, [plaintextRow(PEER, 'Bobby')])).toEqual([
      { peer_id: PEER, nickname: 'Bobby' },
    ]);
  });

  it('skips a row it cannot open rather than failing the whole load', async () => {
    await sodium.ready;
    const vaultKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const otherKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const sealed = await sealForSelf(otherKey, 'Bobby');
    const rows: NicknameRow[] = [
      {
        owner_id: ME,
        peer_id: PEER,
        nickname: null,
        nickname_ciphertext: sealed.ciphertext,
        nickname_nonce: sealed.nonce,
      },
      plaintextRow(OTHER, 'Caz'),
    ];
    // One unreadable name must not cost the sidebar every other name it has.
    expect(await openNicknames(vaultKey, rows)).toEqual([{ peer_id: OTHER, nickname: 'Caz' }]);
  });
});

describe('isPlaintextRow', () => {
  it('is what decides whether 0041 still has work to do on this device', async () => {
    await sodium.ready;
    const vaultKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const sealed = await sealForSelf(vaultKey, 'Bobby');
    expect(isPlaintextRow(plaintextRow(PEER, 'Bobby'))).toBe(true);
    expect(
      isPlaintextRow({
        owner_id: ME,
        peer_id: PEER,
        nickname: null,
        nickname_ciphertext: sealed.ciphertext,
        nickname_nonce: sealed.nonce,
      })
    ).toBe(false);
  });
});

describe('the nickname store', () => {
  it('reports no nickname for an unknown peer, and tolerates a null id', () => {
    resetNicknames();
    expect(nicknameFor(PEER)).toBeNull();
    expect(nicknameFor(null)).toBeNull();
  });

  it('does not publish when a reset would change nothing', () => {
    // Sign-out resets unconditionally; a needless publish there would
    // re-render every subscribed row for no reason.
    resetNicknames();
    const seen: Map<string, string>[] = [];
    const unsubscribe = subscribeNicknames((m) => seen.push(m));
    resetNicknames();
    expect(seen).toHaveLength(0);
    unsubscribe();
  });

  it('stops notifying after unsubscribe', () => {
    const unsubscribe = subscribeNicknames(() => {
      throw new Error('an unsubscribed listener must never be called');
    });
    unsubscribe();
    expect(() => resetNicknames()).not.toThrow();
  });
});
