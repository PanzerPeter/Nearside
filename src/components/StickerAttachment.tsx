import { useSignedMediaUrl } from '../hooks/useSignedMediaUrl';
import { ImageOff } from 'lucide-react';

interface StickerAttachmentProps {
  messageId: string;
  path: string;
  /** The opened file key, from `openRows`. Without it the object is opaque. */
  mediaKey?: Uint8Array | null;
}

/** Fixed, and the same on both sides of the conversation. A sticker whose size
 *  varied with its source image would make the thread ragged, and the whole
 *  point of the form is that it is a stamp rather than a photograph. */
const SIZE = 128;

/**
 * A sticker in the thread.
 *
 * Deliberately not `MediaAttachment`: no lightbox, no zoom cursor, no pin, no
 * save. Opening a sticker full-screen is a gesture with nothing behind it —
 * there is no detail to see at 512px that is not visible at 128 — and the
 * viewer would put a save button on a picture the sender did not take.
 *
 * On the wire this is an ordinary sealed attachment, so it fetches and decrypts
 * through exactly the same path as a photo.
 */
export function StickerAttachment({ messageId, path, mediaKey }: StickerAttachmentProps) {
  const { url, failed, reload } = useSignedMediaUrl(path, mediaKey, 'sticker', messageId);

  if (failed) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-base-content/60">
        <ImageOff className="w-4 h-4" />
        This sticker is no longer available
      </div>
    );
  }

  if (!url) {
    return <div className="rounded-lg bg-base-content/5" style={{ width: SIZE, height: SIZE }} />;
  }

  return (
    <img
      src={url}
      alt="sticker"
      loading="lazy"
      width={SIZE}
      height={SIZE}
      // `block`: an inline image leaves a baseline gap, which with no bubble
      // behind it shows up as the sticker sitting oddly high on its row.
      className="block object-contain"
      style={{ width: SIZE, height: SIZE }}
      onError={reload}
    />
  );
}
