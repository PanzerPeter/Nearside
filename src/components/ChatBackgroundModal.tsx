import { useRef } from 'react';
import { Modal } from './Modal';
import { useToast } from '../hooks/useToast';
import { MAX_BACKGROUND_BYTES } from '../lib/background';
import { ImagePlus, Trash2 } from 'lucide-react';

interface ChatBackgroundModalProps {
  /** Signed URL of the conversation's current background, if any. */
  url: string | null;
  busy: boolean;
  onPick: (file: File) => Promise<string | null>;
  onRemove: () => Promise<string | null>;
  onClose: () => void;
}

/** Picker for a conversation's background image. */
export function ChatBackgroundModal({
  url,
  busy,
  onPick,
  onRemove,
  onClose,
}: ChatBackgroundModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const error = await onPick(file);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success('Background updated.');
    onClose();
  }

  async function handleRemove() {
    const error = await onRemove();
    if (error) {
      toast.error(error);
      return;
    }
    toast.success('Background removed.');
    onClose();
  }

  const maxMb = Math.round(MAX_BACKGROUND_BYTES / (1024 * 1024));

  return (
    <Modal title="Chat background" onClose={onClose}>
      <div className="rounded-xl overflow-hidden border border-base-content/10 bg-base-200 h-40 flex items-center justify-center mb-4">
        {url ? (
          <img src={url} alt="Current chat background" className="w-full h-full object-cover" />
        ) : (
          <span className="text-sm text-base-content/60">No background set</span>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={handleFile}
      />

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? (
            <span className="loading loading-spinner loading-xs" />
          ) : (
            <ImagePlus className="w-4 h-4" />
          )}
          {url ? 'Replace image' : 'Choose image'}
        </button>
        {url && (
          <button
            type="button"
            className="btn btn-ghost btn-sm text-error"
            disabled={busy}
            onClick={handleRemove}
          >
            <Trash2 className="w-4 h-4" />
            Remove
          </button>
        )}
      </div>

      <p className="text-xs text-base-content/60 mt-3">
        PNG, JPEG, WebP or GIF, up to {maxMb} MB.
      </p>
    </Modal>
  );
}
