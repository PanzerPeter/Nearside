import { describe, expect, it } from 'vitest';
import { identityFromSeed, type Identity } from '../crypto/keys';
import { seedFromMnemonic } from '../crypto/mnemonic';
import { openSignal, sealSignal, signalTopic } from './signaling';
import { ENVELOPE_VERSION, isEnvelope, isSignal, type Signal } from './types';

const ALICE_PHRASE =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const BOB_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let alice: Identity;
let bob: Identity;

async function identities() {
  alice ??= await identityFromSeed(await seedFromMnemonic(ALICE_PHRASE));
  bob ??= await identityFromSeed(await seedFromMnemonic(BOB_PHRASE));
  return { alice, bob };
}

const OFFER: Signal = { t: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0', kind: 'video' };

describe('topic', () => {
  it('is the same string from both ends', () => {
    expect(signalTopic('alice', 'bob')).toBe(signalTopic('bob', 'alice'));
  });

  it('is namespaced away from the presence topic on the same pair', () => {
    expect(signalTopic('alice', 'bob')).toBe('call:alice_bob');
  });
});

describe('sealed signals', () => {
  it('round-trips through the peer keypair', async () => {
    const { alice, bob } = await identities();
    const envelope = await sealSignal(alice, bob.boxPublic, 'alice', 'call-1', OFFER);
    expect(await openSignal(bob, alice.boxPublic, envelope)).toEqual(OFFER);
  });

  it('puts nothing but the call id and the sender in clear', async () => {
    const { alice, bob } = await identities();
    const envelope = await sealSignal(alice, bob.boxPublic, 'alice', 'call-1', OFFER);
    // The whole envelope as it goes over the wire. Neither the SDP nor the
    // discriminator may appear anywhere in it: a relay that could read either
    // would learn who is calling whom, and an SDP carries IP addresses.
    const wire = JSON.stringify(envelope);
    expect(wire).not.toContain('v=0');
    expect(wire).not.toContain('IN IP4');
    expect(wire).not.toContain('offer');
    expect(Object.keys(envelope).sort()).toEqual(['callId', 'ciphertext', 'from', 'nonce', 'v']);
  });

  it('hides an ICE candidate, addresses and all', async () => {
    const { alice, bob } = await identities();
    const candidate: Signal = {
      t: 'ice',
      candidate: {
        candidate: 'candidate:1 1 UDP 2130706431 192.168.1.44 54321 typ host',
        sdpMid: '0',
      },
    };
    const envelope = await sealSignal(alice, bob.boxPublic, 'alice', 'call-1', candidate);
    expect(JSON.stringify(envelope)).not.toContain('192.168.1.44');
    expect(await openSignal(bob, alice.boxPublic, envelope)).toEqual(candidate);
  });

  it('gives a fresh nonce to identical signals', async () => {
    const { alice, bob } = await identities();
    const a = await sealSignal(alice, bob.boxPublic, 'alice', 'c', { t: 'hangup' });
    const b = await sealSignal(alice, bob.boxPublic, 'alice', 'c', { t: 'hangup' });
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('returns null rather than throwing on a forged payload', async () => {
    // A broadcast topic is reachable by anyone who knows two user ids, so
    // garbage on it is routine. It must read as noise, not as an exception.
    const { alice, bob } = await identities();
    const envelope = await sealSignal(alice, bob.boxPublic, 'alice', 'c', OFFER);
    const tampered = { ...envelope, ciphertext: envelope.ciphertext.replace(/^./, 'A') };
    expect(await openSignal(bob, alice.boxPublic, tampered)).toBeNull();
    expect(await openSignal(bob, alice.boxPublic, { ...envelope, ciphertext: 'not base64 !!' }))
      .toBeNull();
  });

  it('will not open under a third party key', async () => {
    const { alice, bob } = await identities();
    // Any third keypair; it does not have to come from a phrase.
    const mallory = await identityFromSeed(new Uint8Array(32).fill(7));
    const envelope = await sealSignal(alice, bob.boxPublic, 'alice', 'c', OFFER);
    expect(await openSignal(mallory, alice.boxPublic, envelope)).toBeNull();
  });
});

describe('envelope validation', () => {
  const good = {
    v: ENVELOPE_VERSION,
    callId: 'c1',
    from: 'alice',
    ciphertext: 'x',
    nonce: 'y',
  };

  it('accepts a well formed envelope', () => {
    expect(isEnvelope(good)).toBe(true);
  });

  it('rejects the shapes a hostile or older client could put on the topic', () => {
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope('offer')).toBe(false);
    expect(isEnvelope({ ...good, v: 99 })).toBe(false);
    expect(isEnvelope({ ...good, callId: '' })).toBe(false);
    expect(isEnvelope({ ...good, from: 42 })).toBe(false);
    expect(isEnvelope({ ...good, ciphertext: undefined })).toBe(false);
  });
});

describe('signal validation', () => {
  it('accepts every type this build sends', () => {
    const all: Signal[] = [
      { t: 'offer', sdp: 's', kind: 'voice' },
      { t: 'answer', sdp: 's' },
      { t: 'ice', candidate: { candidate: '' } },
      { t: 'decline' },
      { t: 'busy' },
      { t: 'hangup' },
    ];
    for (const signal of all) expect(isSignal(signal)).toBe(true);
  });

  it('ignores a signal type it has never heard of rather than failing', () => {
    // Version tolerance, not a trust boundary — this runs on plaintext that
    // crypto_box has already authenticated.
    expect(isSignal({ t: 'screenshare', sdp: 's' })).toBe(false);
    expect(isSignal({ t: 'offer', sdp: 's', kind: 'hologram' })).toBe(false);
    expect(isSignal({ t: 'offer' })).toBe(false);
    expect(isSignal({})).toBe(false);
  });
});
