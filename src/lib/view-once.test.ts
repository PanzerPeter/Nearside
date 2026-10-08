import { describe, expect, it } from 'vitest';
import { viewOnceState } from './view-once';

const key = new Uint8Array(32);

describe('viewOnceState', () => {
  it('never lets the sender open their own', () => {
    expect(viewOnceState({ user_id: 'me', viewed_at: null, media_key: key }, 'me')).toBe('sent');
    expect(viewOnceState({ user_id: 'me', viewed_at: 'x', media_key: null }, 'me')).toBe('seen');
  });

  it('is openable once by the recipient, and only with a key', () => {
    expect(viewOnceState({ user_id: 'them', viewed_at: null, media_key: key }, 'me')).toBe('ready');
    expect(viewOnceState({ user_id: 'them', viewed_at: 'x', media_key: key }, 'me')).toBe('opened');
    // The consume clears the key; a row seen without one is spent.
    expect(viewOnceState({ user_id: 'them', viewed_at: null, media_key: null }, 'me')).toBe('opened');
  });
});
