// The peer's current public key and what this device makes of it.

import { useEffect, useState } from 'react';
import { peerPublicKey } from '../lib/peer-keys';
import { verificationState, type VerificationState } from '../lib/verification';
import { toBase64 } from '../lib/crypto/keys';
import { tapWarning } from '../lib/haptics';

export interface PeerTrust {
  /** The peer's published key, or null when they have none (or in the
   *  self-chat, where there is no second party). */
  peerKey: Uint8Array | null;
  trust: VerificationState;
  /** Re-read the key after a verification has dropped the session cache. */
  refresh: () => void;
}

/**
 * `peerPublicKey` records the key on first sight and caches in-module, so this
 * costs one request per peer per session; `refresh` is what forces a re-read
 * after a re-verification has dropped that cache.
 *
 * `isSelf` skips the whole question: there is no second party to be
 * impersonated.
 */
export function usePeerTrust(peerId: string, isSelf: boolean): PeerTrust {
  const [peerKey, setPeerKey] = useState<Uint8Array | null>(null);
  const [trust, setTrust] = useState<VerificationState>('unverified');
  // Bumped after a re-verification, to re-read a key `forgetPeerKey` just
  // dropped from the session cache.
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    if (isSelf) {
      setPeerKey(null);
      setTrust('verified');
      return;
    }
    let cancelled = false;
    void (async () => {
      const key = await peerPublicKey(peerId);
      if (cancelled) return;
      if (!key) {
        // No published key at all. The send path already refuses to seal to
        // nothing; it is not a key *change*, and must not be reported as one.
        setPeerKey(null);
        setTrust('unverified');
        return;
      }
      const state = await verificationState(peerId, await toBase64(key));
      if (cancelled) return;
      setPeerKey(key);
      setTrust(state);
      // A key change blocks the composer, which is a jarring thing to walk
      // into silently. The buzz is the same one Android uses for a warning,
      // and it arrives with the banner rather than after it.
      if (state === 'changed') void tapWarning();
    })();
    return () => {
      cancelled = true;
    };
  }, [peerId, isSelf, epoch]);

  return { peerKey, trust, refresh: () => setEpoch((n) => n + 1) };
}
