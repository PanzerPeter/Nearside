import { useEffect, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { RefreshCw, Sparkles } from 'lucide-react';

/** How often to poll the server for a new service worker while the app is open. */
const UPDATE_POLL_MS = 60_000;
/** How long "Later" buys. Dismissing used to hide the prompt until the next
 *  cold start, which on an installed PWA can be days — the update was found and
 *  then quietly forgotten. Ask again instead. */
const SNOOZE_MS = 15 * 60_000;
/** How long to wait for the waiting worker to take over before reloading
 *  anyway. `updateServiceWorker(true)` reloads on `controllerchange`; if that
 *  event never lands (worker dropped, activation stalled) the user is left
 *  staring at a spinner that will never resolve. */
const RELOAD_FALLBACK_MS = 4_000;

/**
 * Bottom sheet prompting the user to reload when a new version is ready.
 *
 * With `registerType: 'prompt'` the browser only checks for a new service
 * worker on a hard navigation, so a long-lived tab never notices a deploy.
 * Detection is therefore active: poll periodically, and re-check whenever the
 * app regains focus or the network reconnects.
 *
 * A wide card with full-height buttons rather than a corner toast. A ~20px tap
 * target in the bottom corner of a phone is both the hardest place to reach
 * and where the composer's send button lives, so misses land in the chat and
 * the prompt reads as having ignored the tap.
 *
 * `updateServiceWorker(true)` never clears localStorage, where the Supabase
 * session lives, so the user stays signed in across updates.
 */
export function UpdatePrompt() {
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const [registered, setRegistered] = useState(false);
  const [snoozed, setSnoozed] = useState(false);
  const [reloading, setReloading] = useState(false);

  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      registrationRef.current = registration;
      setRegistered(true);
    },
  });

  // Active update detection with proper teardown so nothing leaks.
  useEffect(() => {
    const registration = registrationRef.current;
    if (!registration) return;

    const check = () => {
      if (navigator.onLine) registration.update().catch(() => {});
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };

    const interval = setInterval(check, UPDATE_POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', check);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', check);
    };
  }, [registered]);

  // Timed dismissal rather than a permanent one.
  useEffect(() => {
    if (!snoozed) return;
    const timer = setTimeout(() => setSnoozed(false), SNOOZE_MS);
    return () => clearTimeout(timer);
  }, [snoozed]);

  if (!needRefresh || snoozed) return null;

  function reload() {
    if (reloading) return;
    setReloading(true);
    updateServiceWorker(true);
    setTimeout(() => window.location.reload(), RELOAD_FALLBACK_MS);
  }

  return (
    <div
      // Above the toast layer (z-100): this is the one thing on screen the user
      // is being asked to act on, so nothing transient may sit over its buttons.
      className="fixed inset-x-0 bottom-0 z-[110] flex justify-center px-3 pb-[calc(0.75rem+var(--safe-bottom))] pointer-events-none"
      role="status"
      aria-live="polite"
    >
      <div className="pointer-events-auto w-full max-w-md rounded-2xl bg-base-100/95 backdrop-blur border border-base-content/10 shadow-2xl p-4 animate-message-in">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 grid place-items-center shrink-0">
            <Sparkles className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-snug">Update available</p>
            <p className="text-xs opacity-70 leading-snug mt-0.5">
              Reload to get the latest version. Your chats and login stay as they are.
            </p>
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            className="btn btn-primary flex-1 h-11 min-h-11"
            onClick={reload}
            disabled={reloading}
          >
            <RefreshCw className={`w-4 h-4 ${reloading ? 'animate-spin' : ''}`} />
            {reloading ? 'Updating…' : 'Reload now'}
          </button>
          <button
            type="button"
            className="btn btn-ghost h-11 min-h-11 px-4"
            onClick={() => setSnoozed(true)}
            disabled={reloading}
          >
            Later
          </button>
        </div>
      </div>
    </div>
  );
}
