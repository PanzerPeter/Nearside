import { beforeEach, describe, expect, it } from 'vitest';
import { clearDraft, draftKey, forgetAllDrafts, getDraft, putDraft } from './drafts';

beforeEach(() => {
  forgetAllDrafts();
});

describe('draftKey', () => {
  // A room and a peer can never collide, but the ids come from two different
  // tables and nothing else guarantees that.
  it('separates a room from a peer with the same id', () => {
    expect(draftKey('peer', 'abc')).not.toBe(draftKey('room', 'abc'));
  });
});

describe('drafts', () => {
  it('gives back what was put', () => {
    putDraft(draftKey('peer', 'alice'), 'half a sentence');
    expect(getDraft(draftKey('peer', 'alice'))).toBe('half a sentence');
  });

  it('answers empty for a conversation nobody has typed in', () => {
    expect(getDraft(draftKey('peer', 'bob'))).toBe('');
  });

  // The bug this whole module exists for: text typed to one person appearing
  // in the box under another person's name, one Enter from being sent there.
  it('keeps two conversations apart', () => {
    putDraft(draftKey('peer', 'alice'), 'for alice');
    putDraft(draftKey('peer', 'bob'), 'for bob');
    expect(getDraft(draftKey('peer', 'alice'))).toBe('for alice');
    expect(getDraft(draftKey('peer', 'bob'))).toBe('for bob');
  });

  it('forgets a conversation whose draft was emptied by hand', () => {
    const key = draftKey('peer', 'alice');
    putDraft(key, 'typed');
    putDraft(key, '');
    expect(getDraft(key)).toBe('');
  });

  // Whitespace is not a draft. Without this, backspacing over a message down
  // to a stray space would leave the conversation looking like it had one.
  it('treats whitespace as no draft at all', () => {
    const key = draftKey('peer', 'alice');
    putDraft(key, '   \n ');
    expect(getDraft(key)).toBe('');
  });

  it('clears one conversation without touching the rest', () => {
    putDraft(draftKey('peer', 'alice'), 'for alice');
    putDraft(draftKey('room', 'r1'), 'for the room');
    clearDraft(draftKey('peer', 'alice'));
    expect(getDraft(draftKey('peer', 'alice'))).toBe('');
    expect(getDraft(draftKey('room', 'r1'))).toBe('for the room');
  });

  // Drafts are the account's, so switching accounts must not carry them over.
  it('drops everything on forgetAllDrafts', () => {
    putDraft(draftKey('peer', 'alice'), 'for alice');
    putDraft(draftKey('room', 'r1'), 'for the room');
    forgetAllDrafts();
    expect(getDraft(draftKey('peer', 'alice'))).toBe('');
    expect(getDraft(draftKey('room', 'r1'))).toBe('');
  });
});
