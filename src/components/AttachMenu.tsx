import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Camera, Image as ImageIcon, Video } from 'lucide-react';

interface AttachMenuProps {
  open: boolean;
  onClose: () => void;
  /** Open the camera app for a still photo. */
  onTakePhoto: () => void;
  /** Open the camera app in video mode. */
  onRecordVideo: () => void;
  /** Open the normal picker over the gallery/filesystem. */
  onChooseLibrary: () => void;
}

/**
 * Attachment source picker.
 *
 * Only mounted on devices where `<input capture>` actually reaches a camera
 * (see `supportsCameraCapture`) — on a desktop the paperclip opens the file
 * picker directly, because a sheet offering "Take photo" that lands in the
 * filesystem is worse than no sheet at all. That constraint is why this is a
 * bottom sheet rather than an anchored popover: everything that sees it is
 * holding a phone.
 */
export function AttachMenu({
  open,
  onClose,
  onTakePhoto,
  onRecordVideo,
  onChooseLibrary,
}: AttachMenuProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const entries = [
    { label: 'Take photo', icon: Camera, run: onTakePhoto },
    { label: 'Record video', icon: Video, run: onRecordVideo },
    { label: 'Photo & video library', icon: ImageIcon, run: onChooseLibrary },
  ];

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="Choose attachment source"
      onClick={onClose}
    >
      <div
        className="w-full rounded-t-2xl bg-base-100 p-2 pb-[calc(0.5rem+var(--safe-bottom))] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-2 mt-1 h-1 w-10 rounded-full bg-base-content/20" />
        {entries.map(({ label, icon: Icon, run }) => (
          <button
            key={label}
            type="button"
            className="flex w-full items-center gap-3 rounded-xl px-4 py-3.5 text-left text-sm font-medium transition-colors active:bg-base-content/10"
            onClick={() => {
              // Close first: the file input's click has to land while this
              // handler is still inside the user gesture, and iOS drops the
              // picker if the element is torn down underneath it afterwards.
              onClose();
              run();
            }}
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
              <Icon className="h-[18px] w-[18px]" />
            </span>
            {label}
          </button>
        ))}
      </div>
    </div>,
    document.body
  );
}
