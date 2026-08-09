import { useEffect, useRef, useState } from 'react';
import { Camera, ShieldCheck } from 'lucide-react';
import { SCAN_MESSAGES, scanQr } from '../lib/scan';
import { safetyNumber } from '../lib/crypto/safety';
import { safetyArt, type SafetyArt } from '../lib/crypto/safety-art';
import { toBase64 } from '../lib/crypto/keys';
import { parseSafetyPayload, safetyPayload } from '../lib/connect';
import { forgetPeerKey } from '../lib/peer-keys';
import { markVerified } from '../lib/verification';
import { useToast } from '../hooks/useToast';
import { Modal } from './Modal';
import { QrCode } from './QrCode';
import { SafetySigil } from './SafetySigil';

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

const PAGES = ['Picture and words', 'Digits', 'QR code'];

/**
 * The same check in three forms, one screen each: a picture and four words, the
 * sixty digits they come from, and a code to scan. They are the same comparison
 * — which one is usable depends on whether you are in the room, on a call, or
 * holding both phones — and stacking all three down one modal made the shortest
 * of them look like a preamble to the longest.
 *
 * "Mark verified" stays disabled until either a scan matched or the user ticked
 * the box saying they compared. A verify button anyone can press without
 * looking at anything is a button that records a claim nobody made.
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
  const [art, setArt] = useState<SafetyArt | null>(null);
  const [compared, setCompared] = useState(false);
  const [scanMatched, setScanMatched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const track = useRef<HTMLDivElement>(null);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const n = await safetyNumber(myPublic, theirPublic);
      if (cancelled) return;
      setNumber(n);
      setArt(await safetyArt(n));
    })();
    return () => {
      cancelled = true;
    };
  }, [myPublic, theirPublic]);

  function goTo(index: number) {
    const el = track.current;
    if (!el) return;
    el.scrollTo({ left: index * el.clientWidth, behavior: 'smooth' });
  }

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
        <div className="space-y-3">
          {/* One scroll container, three snap points. No carousel library: the
              platform already does this, and does it with the right inertia. */}
          <div
            ref={track}
            onScroll={(e) => {
              const el = e.currentTarget;
              setPage(Math.round(el.scrollLeft / el.clientWidth));
            }}
            className="flex overflow-x-auto snap-x snap-mandatory min-h-[18rem] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <section className="w-full shrink-0 snap-center flex flex-col items-center justify-center gap-3 px-1">
              {art && <SafetySigil art={art} size={132} />}
              <p className="font-mono text-sm tracking-wide">{art?.words.join(' · ')}</p>
              <p className="text-xs text-base-content/60 text-center max-w-xs">
                The same picture and words on both phones. Read them aloud on a call where you
                recognise the voice.
              </p>
            </section>

            <section className="w-full shrink-0 snap-center flex flex-col justify-center gap-3 px-1">
              <div className="grid grid-cols-3 gap-1.5 font-mono text-center">
                {groups.map((group, i) => (
                  <span key={i} className="rounded-lg bg-base-200/60 py-1.5 text-sm tracking-wider">
                    {group}
                  </span>
                ))}
              </div>
              <p className="text-xs text-base-content/60 text-center">
                Where the picture and the words come from. Sixty digits, identical on both phones.
              </p>
            </section>

            <section className="w-full shrink-0 snap-center flex flex-col items-center justify-center gap-3 px-1">
              <div className="rounded-2xl bg-white p-2">
                <QrCode text={safetyPayload(number)} size={168} />
              </div>
              <button
                className="btn btn-outline btn-sm gap-2"
                onClick={() => void scanTheirs()}
                disabled={busy}
              >
                <Camera className="w-4 h-4" />
                Scan theirs
              </button>
              <p className="text-xs text-base-content/60 text-center max-w-xs">
                Point this phone at the code on theirs. The app compares for you.
              </p>
            </section>
          </div>

          <div className="flex justify-center gap-2">
            {PAGES.map((label, i) => (
              <button
                key={label}
                type="button"
                aria-label={label}
                aria-current={page === i}
                onClick={() => goTo(i)}
                className={`h-2 rounded-full transition-all ${
                  page === i ? 'w-5 bg-primary' : 'w-2 bg-base-content/25'
                }`}
              />
            ))}
          </div>

          {/* Below the pager, so the thing that records the claim never scrolls
              out from under the thing being claimed. */}
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
                I compared these with {peerLabel} and they are identical.
              </span>
            </label>
          )}
        </div>
      )}
    </Modal>
  );
}
