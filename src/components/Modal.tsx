import type { ReactNode } from 'react';
import { useLayoutEffect, useRef } from 'react';
import { X } from 'lucide-react';

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
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();

    function handleClose() {
      onCloseRef.current();
    }
    // Escape fires a cancelable `cancel` event whose default (unprevented)
    // action closes the dialog and fires `close` right after — so `close`
    // alone already covers Escape. Do not also listen for `cancel`; that
    // just double-fires onClose for the same user action.
    dialog.addEventListener('close', handleClose);
    return () => {
      dialog.removeEventListener('close', handleClose);
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
        className={`modal-box bg-base-100 border border-base-content/10 shadow-modal max-h-[calc(100dvh-5em-var(--safe-top)-var(--safe-bottom))]${className ? ` ${className}` : ''}`}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-lg">{title}</h3>
          <button
            className="btn btn-ghost btn-sm btn-square"
            onClick={() => ref.current?.close()}
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {children}
        {actions && <div className="modal-action">{actions}</div>}
      </div>
      <form method="dialog" className="modal-backdrop">
        <button>close</button>
      </form>
    </dialog>
  );
}
