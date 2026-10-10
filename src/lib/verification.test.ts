import { beforeEach, describe, expect, it } from 'vitest';
import { clearLocalDb, openLocalDb } from './localdb';
import { markVerified, pinnedKeys, recordPeerKey, verificationState } from './verification';

const ME = '11111111-1111-1111-1111-111111111111';
const PEER = '22222222-2222-2222-2222-222222222222';

describe('verification', () => {
  beforeEach(async () => {
    await openLocalDb(ME);
    await clearLocalDb();
  });

  it('starts unverified', async () => {
    expect(await verificationState(PEER, 'keyA')).toBe('unverified');
  });

  it('becomes verified after marking', async () => {
    await markVerified(PEER, 'keyA');
    expect(await verificationState(PEER, 'keyA')).toBe('verified');
  });

  it('reports a changed key as changed, not as unverified', async () => {
    // The distinction is the whole security property: "we never verified" is
    // routine, "the key you verified is not the key you are talking to now"
    // is what an interception looks like.
    await markVerified(PEER, 'keyA');
    expect(await verificationState(PEER, 'keyB')).toBe('changed');
  });

  it('reports a changed key even when it was never verified', async () => {
    // A key we recorded but never confirmed in person is still a key. If it
    // changes, that is 'changed' — silently downgrading it to 'unverified'
    // would hide precisely the event this feature exists to surface.
    await recordPeerKey(PEER, 'keyA');
    expect(await verificationState(PEER, 'keyA')).toBe('unverified');
    expect(await verificationState(PEER, 'keyB')).toBe('changed');
  });

  it('does not let trust-on-first-use overwrite a key it already has', async () => {
    // recordPeerKey runs on every key fetch. If it adopted whatever the server
    // just handed over, a swapped key would rewrite the record it was supposed
    // to be caught by, and 'changed' would be unreachable.
    await markVerified(PEER, 'keyA');
    await recordPeerKey(PEER, 'keyB');
    expect(await verificationState(PEER, 'keyA')).toBe('verified');
  });

  it('forgets everything on clear, so a signed-out device trusts nothing', async () => {
    await markVerified(PEER, 'keyA');
    await clearLocalDb();
    expect(await verificationState(PEER, 'keyA')).toBe('unverified');
  });
});

describe('pinned keys for a group', () => {
  // Groups took both keys exactly as the server published them. The pin is
  // what makes a swap after first sight come back unusable instead.
  beforeEach(async () => {
    await openLocalDb(ME);
    await clearLocalDb();
  });

  it('takes the first pair it sees', async () => {
    const first = { public_key: 'box-1', signing_key: 'sign-1' };
    expect(await pinnedKeys(PEER, first)).toEqual(first);
    expect(await pinnedKeys(PEER, first)).toEqual(first);
  });

  it('refuses a swapped signing key', async () => {
    await pinnedKeys(PEER, { public_key: 'box-1', signing_key: 'sign-1' });
    expect(await pinnedKeys(PEER, { public_key: 'box-1', signing_key: 'sign-evil' })).toEqual({
      public_key: 'box-1',
      signing_key: null,
    });
  });

  it('refuses both keys when the box key changed', async () => {
    await pinnedKeys(PEER, { public_key: 'box-1', signing_key: 'sign-1' });
    expect(await pinnedKeys(PEER, { public_key: 'box-evil', signing_key: 'sign-1' })).toEqual({
      public_key: null,
      signing_key: null,
    });
  });

  it('pins a signing key for a contact the 1:1 path recorded without one', async () => {
    await recordPeerKey(PEER, 'box-1');
    await pinnedKeys(PEER, { public_key: 'box-1', signing_key: 'sign-1' });
    expect(
      (await pinnedKeys(PEER, { public_key: 'box-1', signing_key: 'sign-evil' })).signing_key
    ).toBeNull();
  });

  it('keeps the signing pin through a verification of the same key', async () => {
    await pinnedKeys(PEER, { public_key: 'box-1', signing_key: 'sign-1' });
    await markVerified(PEER, 'box-1');
    expect(
      (await pinnedKeys(PEER, { public_key: 'box-1', signing_key: 'sign-evil' })).signing_key
    ).toBeNull();
  });

  it('re-pins after a human verifies a new key', async () => {
    await pinnedKeys(PEER, { public_key: 'box-1', signing_key: 'sign-1' });
    await markVerified(PEER, 'box-2');
    const next = { public_key: 'box-2', signing_key: 'sign-2' };
    expect(await pinnedKeys(PEER, next)).toEqual(next);
  });
});
