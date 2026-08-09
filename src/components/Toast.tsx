import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useToast, type ToastKind } from '../hooks/useToast';

// Same inline-alert palette as AuthForm's error/notice boxes, just with a
// stronger border so the toast reads against arbitrary content behind it
// instead of a card's own background.
const KIND_STYLES: Record<ToastKind, string> = {
  error: 'bg-error/15 border-error/30 text-error',
  success: 'bg-success/15 border-success/30 text-success',
};

/**
 * Body-level portal so the stack floats above every screen (chat, modals,
 * friends list) without any one of them needing to know it exists. Anchored
 * above the composer rather than the true viewport bottom so it never
 * overlaps the message input.
 */
export function Toast() {
  const { toasts, dismiss } = useToast();

  if (toasts.length === 0) return null;

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-[calc(5rem+var(--safe-bottom))] z-[100] flex flex-col items-center gap-2 px-4 pointer-events-none"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex items-center gap-2 max-w-sm w-full sm:w-auto rounded-lg border px-3 py-2.5 shadow-lg backdrop-blur-sm ${KIND_STYLES[toast.kind]}`}
        >
          <p className="text-sm flex-1">{toast.message}</p>
          <button
            type="button"
            onClick={() => dismiss(toast.id)}
            className="btn btn-ghost btn-xs btn-square shrink-0"
            title="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>,
    document.body
  );
}
