import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { Camera, QrCode as QrCodeIcon, RefreshCw } from 'lucide-react';
import { scanMessage, scanQr } from '../lib/scan';
import { supabase } from '../lib/supabase';
import type { Identity } from '../lib/crypto/keys';
import {
  CONNECT_CODE_TTL_MS,
  connectPayload,
  mintConnectCode,
  parseConnectPayload,
  redeemConnectCode,
} from '../lib/connect';
import { markVerified } from '../lib/verification';
import { useToast } from '../hooks/useToast';
import { Modal } from './Modal';
import { QrCode } from './QrCode';
import { useT } from '../hooks/useT';

interface ConnectModalProps {
  session: Session;
  identity: Identity;
  onClose: () => void;
  /** Which side of the exchange the caller is offering. Defaults to showing a
   *  code; the first-run card opens straight onto the camera when the user
   *  picked "Scan", since landing on the wrong tab costs a tap at exactly the
   *  moment two people are holding phones up at each other. */
  initialTab?: Tab;
}

type Tab = 'show' | 'scan';

/**
 * Connecting without a directory.
 *
 * There is nothing to search, so one side shows a code and the other reads it
 * — by camera, or by voice down a phone line. The QR carries the shower's
 * public key alongside the token, so a scan verifies the contact in the same
 * gesture that adds them; a code typed from memory cannot, and lands as an
 * ordinary unverified contact.
 */
export function ConnectModal({ session, identity, onClose, initialTab = 'show' }: ConnectModalProps) {
  const t = useT();
  const [tab, setTab] = useState<Tab>(initialTab);
  const toast = useToast();

  return (
    <Modal
      title={t('connect.title')}
      onClose={onClose}
      actions={
        <button className="btn btn-ghost" onClick={onClose}>
          {t('common.close')}
        </button>
      }
    >
      <div role="tablist" className="tabs tabs-boxed bg-base-200/50 mb-4">
        <button
          role="tab"
          className={`tab gap-1.5 ${tab === 'show' ? 'tab-active' : ''}`}
          onClick={() => setTab('show')}
        >
          <QrCodeIcon className="w-4 h-4" />
          {t('firstRun.myCode')}
        </button>
        <button
          role="tab"
          className={`tab gap-1.5 ${tab === 'scan' ? 'tab-active' : ''}`}
          onClick={() => setTab('scan')}
        >
          <Camera className="w-4 h-4" />
          {t('connect.addSomeone')}
        </button>
      </div>

      {tab === 'show' ? (
        <ShowCode session={session} identity={identity} />
      ) : (
        <AddSomeone me={session.user.id} onConnected={onClose} toastError={toast.error} />
      )}
    </Modal>
  );
}

/** Minutes:seconds left on the current token, or null once it has expired. */
function remaining(mintedAt: number, now: number): string | null {
  const left = mintedAt + CONNECT_CODE_TTL_MS - now;
  if (left <= 0) return null;
  const total = Math.ceil(left / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function ShowCode({ session, identity }: { session: Session; identity: Identity }) {
  const t = useT();
  const [code, setCode] = useState<string | null>(null);
  const [payload, setPayload] = useState<string | null>(null);
  const [mintedAt, setMintedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [minting, setMinting] = useState(false);
  const [failed, setFailed] = useState(false);

  const mint = useCallback(async () => {
    setMinting(true);
    setFailed(false);
    try {
      const minted = await mintConnectCode();
      setCode(minted);
      setPayload(await connectPayload(session, identity, minted));
      setMintedAt(Date.now());
      setNow(Date.now());
    } catch {
      // No reason shown: minting fails for one reason the user can act on
      // (they are offline) and nothing else worth naming.
      setFailed(true);
    } finally {
      setMinting(false);
    }
  }, [session, identity]);

  useEffect(() => {
    void mint();
  }, [mint]);

  // A second-resolution countdown, not a one-shot timeout: the number on
  // screen is the only thing telling the other person whether it is still
  // worth typing.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const left = mintedAt ? remaining(mintedAt, now) : null;
  const expired = !!mintedAt && left === null;

  if (failed) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-base-content/60 mb-4">{t('connect.noCode')}</p>
        <button className="btn btn-primary btn-sm gap-1.5" onClick={() => void mint()}>
          <RefreshCw className="w-3.5 h-3.5" />
          {t('connect.tryAgain')}
        </button>
      </div>
    );
  }

  if (!code || !payload) {
    return (
      <div className="flex justify-center py-12">
        <span className="loading loading-spinner" />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-sm text-base-content/60 text-center">{t('connect.showBody')}</p>

      {/* The white here is cosmetic — the quiet zone a scanner needs lives
          inside the SVG, where a container class cannot forget it. */}
      <div className={`rounded-2xl bg-white p-2 ${expired ? 'opacity-30' : ''}`}>
        <QrCode text={payload} size={224} />
      </div>

      <p
        className={`font-mono text-2xl tracking-[0.3em] pl-[0.3em] ${
          expired ? 'text-base-content/30 line-through' : ''
        }`}
      >
        {code}
      </p>

      {expired ? (
        <button className="btn btn-primary btn-sm gap-1.5" onClick={() => void mint()} disabled={minting}>
          <RefreshCw className="w-3.5 h-3.5" />
          {t('connect.newCode')}
        </button>
      ) : (
        <p className="text-xs text-base-content/55">{t('connect.expiresIn', { time: left ?? '' })}</p>
      )}
    </div>
  );
}

interface AddSomeoneProps {
  me: string;
  onConnected: () => void;
  toastError: (message: string) => void;
}

function AddSomeone({ me, onConnected, toastError }: AddSomeoneProps) {
  const t = useT();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  // The modal can unmount while a scan or a redeem is in flight; nothing may
  // touch state after that.
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  /**
   * Redeems, then adds. `publicKey` is present only on the camera path — a
   * key that arrived by QR was held up in front of the person scanning it,
   * which is the whole of what verification means, so it is marked verified
   * here rather than left as a chore nobody comes back to.
   */
  const connect = useCallback(
    async (code: string, publicKey: string | null) => {
      setBusy(true);
      try {
        const peerId = await redeemConnectCode(code);

        const { data: existing } = await supabase
          .from('friendships')
          .select('id, requester_id, status')
          .or(
            `and(requester_id.eq.${me},addressee_id.eq.${peerId}),` +
              `and(requester_id.eq.${peerId},addressee_id.eq.${me})`
          );

        const prior = existing?.[0];
        // The key is recorded either way. A code redeemed for someone already
        // in the list is still a key handed over in person.
        if (publicKey) await markVerified(peerId, publicKey);

        if (prior) {
          toastError(
            prior.status === 'accepted'
              ? t('connect.alreadyFriends')
              : prior.requester_id === me
                ? t('connect.alreadySent')
                : t('connect.alreadyReceived')
          );
          return;
        }

        const { error } = await supabase
          .from('friendships')
          .insert({ requester_id: me, addressee_id: peerId });

        if (error) {
          toastError(
            /rate_limited_requests/.test(error.message)
              ? t('connect.rateLimited')
              : // `friendships_unique_pair` (0034) holds one row per pair in
                // either direction, so the check above losing a race with the
                // other person's own redeem lands here rather than creating a
                // second, independently acceptable row.
                /duplicate key|unique constraint/i.test(error.message)
                ? t('connect.raced')
                : error.message
          );
          return;
        }
        if (alive.current) onConnected();
      } catch {
        // Spent, expired, unknown and self-issued are one message on purpose:
        // telling them apart would confirm which codes exist.
        toastError(t('connect.badCode'));
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [me, onConnected, toastError, t]
  );

  async function scan() {
    setBusy(true);
    try {
      const result = await scanQr();
      if ('failure' in result) {
        if (result.failure !== 'cancelled') toastError(scanMessage(result.failure));
        return;
      }

      const parsed = parseConnectPayload(result.value);
      if (!parsed) {
        toastError("That QR isn't a Nearside code.");
        return;
      }
      await connect(parsed.token, parsed.publicKey);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const cleaned = typed.trim().toUpperCase();

  return (
    <div className="space-y-5">
      <div>
        <button
          className="btn btn-primary w-full gap-2"
          onClick={() => void scan()}
          disabled={busy}
        >
          <Camera className="w-4 h-4" />
          {t('connect.scanTheirs')}
        </button>
        <p className="text-xs text-base-content/55 mt-2 text-center">{t('connect.scanVerifies')}</p>
      </div>

      <div className="divider text-xs text-base-content/55">{t('connect.or')}</div>

      <div>
        <label className="text-sm text-base-content/60" htmlFor="connect-code">
          {t('connect.typeCode')}
        </label>
        <div className="join w-full mt-2">
          <input
            id="connect-code"
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={8}
            placeholder="ABCD2345"
            className="input join-item flex-1 bg-base-200/50 border border-base-content/10 focus:border-primary font-mono tracking-[0.2em] uppercase"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && cleaned.length === 8 && void connect(cleaned, null)}
          />
          <button
            className="btn btn-primary join-item"
            disabled={busy || cleaned.length !== 8}
            onClick={() => void connect(cleaned, null)}
          >
            {busy ? <span className="loading loading-spinner loading-xs" /> : t('connect.add')}
          </button>
        </div>
      </div>
    </div>
  );
}
