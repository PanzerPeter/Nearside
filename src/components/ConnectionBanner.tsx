import { useEffect, useState } from 'react';
import { CloudOff, RotateCw, WifiOff } from 'lucide-react';
import { useConnection, pokeConnection } from '../lib/connection';

/** How long realtime has to stay down before saying so. Every reconnect and
 *  every channel rejoin passes briefly through "not subscribed"; announcing
 *  those would make the banner blink on a perfectly healthy connection. It is
 *  generous because nothing is actually broken meanwhile — messages keep
 *  sending and arriving over the polling fallback. */
const GRACE_MS = 8_000;
/** How long the pill states its case before shrinking to its icon. An outage
 *  can last minutes; a banner that keeps a sentence on screen for all of them
 *  stops being information and becomes furniture in the way. */
const COLLAPSE_MS = 6_000;

/**
 * Tells the user when live delivery is down, instead of leaving them with a
 * conversation that looks normal and silently isn't updating.
 *
 * Deliberately quiet about it. Losing the socket is not an outage: messages
 * still send and still arrive, just over the polling fallback — which is the
 * honest description on a censored or heavily-proxied network, where wss:// is
 * what breaks while ordinary HTTPS keeps working. So it waits before speaking,
 * says one short thing, then collapses to a status dot the user can ignore or
 * tap to retry. Losing the *network* is a different claim, and gets different
 * words.
 */
export function ConnectionBanner() {
  const { live, online } = useConnection();
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (live) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => {
      setVisible(true);
      setExpanded(true);
    }, GRACE_MS);
    return () => clearTimeout(timer);
  }, [live]);

  useEffect(() => {
    if (!visible || !expanded) return;
    const timer = setTimeout(() => setExpanded(false), COLLAPSE_MS);
    return () => clearTimeout(timer);
  }, [visible, expanded]);

  if (!visible) return null;

  const Icon = online ? CloudOff : WifiOff;
  const label = online ? 'Reconnecting' : 'No internet connection';

  // Re-expands so the tap is acknowledged, rather than leaving a collapsed
  // pill that gives no sign it did anything.
  function retry() {
    setExpanded(true);
    pokeConnection();
  }

  return (
    <div
      className="fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-[calc(0.5rem+var(--safe-top))] pointer-events-none"
      // polite, and on the wrapper rather than the pill: the collapse is a
      // visual change, not new information, and should not be re-announced.
      role="status"
      aria-live="polite"
    >
      <button
        type="button"
        onClick={retry}
        // Neutral surface rather than the warning colour it used to wear: an
        // amber bar across the top of the app reads as "something is wrong
        // with your account", which is a much bigger claim than "the socket
        // is down and we are polling instead".
        className="pointer-events-auto flex items-center gap-2 rounded-full bg-base-100/95 text-base-content border border-base-content/10 shadow-lg backdrop-blur px-3 py-1.5 text-xs font-medium hover:bg-base-100 transition-colors"
        title={`${label}. Tap to retry.`}
        aria-label={`${label}. Tap to retry now.`}
      >
        <Icon className="w-3.5 h-3.5 shrink-0 text-warning" />
        {expanded && (
          <>
            <span>{label}</span>
            <RotateCw className="w-3 h-3 shrink-0 opacity-70" />
          </>
        )}
      </button>
    </div>
  );
}
