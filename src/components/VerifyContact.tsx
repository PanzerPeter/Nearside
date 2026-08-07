import { useEffect, useState } from 'react';
import { Camera, ShieldCheck } from 'lucide-react';
import { SCAN_MESSAGES, scanQr } from '../lib/scan';
import { safetyNumber } from '../lib/crypto/safety';
import { toBase64 } from '../lib/crypto/keys';
import { parseSafetyPayload, safetyPayload } from '../lib/connect';
import { forgetPeerKey } from '../lib/peer-keys';
import { markVerified } from '../lib/verification';
import { useToast } from '../hooks/useToast';
import { Modal } from './Modal';
import { QrCode } from './QrCode';

interface VerifyContactProps {
  peerId: string;
  peerLabel: string;
  myPublic: Uint8Array;
  theirPublic: Uint8Array;
  /** Fired after the contact has been marked verified, so the caller can
   *  re-read the state it was blocking on. */
  onVerified: () => void;
  onClose: () => void;
}

/**
 * The same sixty digits on both phones, or they are not talking to each other.
 *
 * "Mark verified" stays disabled until either a scan matched or the user
 * ticked the box saying they compared the digits themselves. A verify button
 * anyone can press without looking at anything is a button that records a
 * claim nobody made.
 */
export function VerifyContact({
  peerId,
  peerLabel,
  myPublic,
  theirPublic,
  onVerified,
  onClose,
}: VerifyContactProps) {
  const [number, setNumber] = useState<string | null>(null);
  const [compared, setCompared] = useState(false);
  const [scanMatched, setScanMatched] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const n = await safetyNumber(myPublic, theirPublic);
      if (!cancelled) setNumber(n);
    })();
    return () => {
      cancelled = true;
    };
  }, [myPublic, theirPublic]);

  async function scanTheirs() {
    if (!number) return;
    setBusy(true);
    try {
      const result = await scanQr();
      if ('failure' in result) {
        if (result.failure === 'unsupported-platform') {
          toast.error('Scanning needs the app. Compare the digits instead.');
        } else if (result.failure !== 'cancelled') {
          toast.error(SCAN_MESSAGES[result.failure]);
        }
        return;
      }

      const scanned = parseSafetyPayload(result.value);
      if (!scanned) {
        toast.error('That is not a safety-number code.');
        return;
      }
      if (scanned !== number.replace(/\s+/g, '')) {
        // Not a soft failure. Either one of you is looking at the wrong
        // contact, or someone is sitting between you.
        setScanMatched(false);
        toast.error('These do not match. Do not carry on until they do.');
        return;
      }
      setScanMatched(true);
      toast.success('The numbers match.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    try {
      await markVerified(peerId, await toBase64(theirPublic));
      // Drop the session cache so the next read comes back from the server —
      // re-verifying after a key change is pointless if the old key is still
      // the one being sealed to.
      forgetPeerKey(peerId);
      onVerified();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const groups = number?.split(' ') ?? [];

  return (
    <Modal
      title={`Verify ${peerLabel}`}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary gap-1.5"
            disabled={!number || busy || (!scanMatched && !compared)}
            onClick={() => void confirm()}
          >
            <ShieldCheck className="w-4 h-4" />
            Mark verified
          </button>
        </>
      }
    >
      {!number ? (
        <div className="flex justify-center py-12">
          <span className="loading loading-spinner" />
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-base-content/60">
            These digits are the same on both phones, but only if nobody is in between. Compare
            them in person, or over a call where you recognise the voice.
          </p>

          <div className="grid grid-cols-3 gap-1.5 font-mono text-center">
            {groups.map((group, i) => (
              <span key={i} className="rounded-lg bg-base-200/60 py-1.5 text-sm tracking-wider">
                {group}
              </span>
            ))}
          </div>

          <div className="flex justify-center">
            <div className="rounded-2xl bg-white p-2">
              <QrCode text={safetyPayload(number)} size={200} />
            </div>
          </div>

          <button
            className="btn btn-outline w-full gap-2"
            onClick={() => void scanTheirs()}
            disabled={busy}
          >
            <Camera className="w-4 h-4" />
            Scan theirs
          </button>

          {scanMatched ? (
            <p className="text-sm text-success flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4" />
              Scanned and matching.
            </p>
          ) : (
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                className="checkbox checkbox-sm mt-0.5"
                checked={compared}
                onChange={(e) => setCompared(e.target.checked)}
              />
              <span className="text-sm text-base-content/70">
                I compared these digits with {peerLabel} and they are identical.
              </span>
            </label>
          )}
        </div>
      )}
    </Modal>
  );
}
