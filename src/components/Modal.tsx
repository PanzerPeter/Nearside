import type { ReactNode } from 'react';
import { useLayoutEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useT } from '../hooks/useT';
import { expressiveMotion, MOTION } from '../lib/motion';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/**
 * Wraps <dialog> so every modal in the app gets real modal behaviour for
 * free: showModal() traps focus, makes the background inert, renders the
 * ::backdrop, and restores focus to the trigger on close — none of which the
 * old `modal modal-open` class hack provided.
 *
 *
 * It is a layout effect, not a passive one, for the teardown's sake: see the
 * cleanup below.
 */
export function Modal({ title, onClose, children, actions, className = '' }: ModalProps) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  /**
   * Close the way the dialog opened: animated. The dialog stays open, marked
   * `data-closing`, for the exit animation in index.css, then closes for real,
   * which fires `close` and so `onClose` exactly as before. Only the three
   * routes the dialog owns come through here — the X, the scrim and Escape. A
   * caller unmounting us directly (a footer button) still leaves at once:
   * there is nothing left to animate by the time we hear about it.
   */
  function dismiss() {
    const dialog = ref.current;
    if (!dialog?.open || dialog.hasAttribute('data-closing')) return;
    if (!expressiveMotion()) {
      dialog.close();
      return;
    }
    dialog.setAttribute('data-closing', '');
    setTimeout(() => dialog.close(), MOTION.exit.duration);
  }
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();

    function handleClose() {
      // `close` is dispatched as a task, after the call that caused it. Under
      // StrictMode the dev build runs this effect, its cleanup and the effect
      // again on mount: the cleanup's `dialog.close()` queues a `close` that
      // lands after `showModal()` has reopened the dialog, on the listener the
      // second run added — and every modal in `npm run dev` shut the instant
      // it opened. A real close always finds the dialog already closed.
      if (dialog!.open) return;
      onCloseRef.current();
    }
    // Escape fires a cancelable `cancel` whose default action closes the
    // dialog and fires `close` right after. It is prevented here only to be
    // routed through `dismiss`, which ends in the same `close` — so `onClose`
    // still fires once. Chrome refuses to let a page cancel a second Escape
    // without a click between; that one closes at once, which is fine.
    function handleCancel(e: Event) {
      e.preventDefault();
      dismissRef.current();
    }
    dialog.addEventListener('close', handleClose);
    dialog.addEventListener('cancel', handleCancel);
    return () => {
      dialog.removeEventListener('close', handleClose);
      dialog.removeEventListener('cancel', handleCancel);
      // A close triggered without going through dialog.close() (a footer
      // button, or a caller like AddFriendModal's success path, calling
      // onClose directly) unmounts us before the dialog's own close() ever
      // runs — and that call is what drives the browser's focus-restoration
      // step. Trigger it here instead. Only a layout-effect cleanup can:
      // React detaches deleted host nodes in the mutation phase and flushes
      // passive cleanups after, by which point there is no attached dialog
      // left to restore focus from.
      if (dialog.open) dialog.close();
    };
    // Deliberately empty: this must run exactly once per mount. onClose is
    // read through the ref above so a fresh inline arrow from the parent on
    // every render doesn't tear the dialog down and reopen it.
  }, []);

  return (
    <dialog ref={ref} className="modal">
      {/* daisyUI caps modal-box at `100vh - 5em`, and under edge-to-edge that
          100vh counts the status bar and the gesture pill as usable height —
          so a modal tall enough to hit the cap runs under both. */}
      <div
        className={`modal-box bg-base-100 border border-hairline shadow-modal max-h-[calc(100dvh-5em-var(--safe-top)-var(--safe-bottom))]${className ? ` ${className}` : ''}`}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-title">{title}</h3>
          <button
            className="btn btn-ghost btn-sm btn-square"
            onClick={dismiss}
            title={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {children}
        {actions && <div className="modal-action">{actions}</div>}
      </div>
      <form
        method="dialog"
        className="modal-backdrop"
        onSubmit={(e) => {
          e.preventDefault();
          dismiss();
        }}
      >
        <button>close</button>
      </form>
    </dialog>
  );
}
