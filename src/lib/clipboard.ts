// Putting a picture on the clipboard.
//
// Text has had `navigator.clipboard.writeText` for years and the app has used
// it for message bodies all along. An image is the awkward case: the clipboard
// only takes a handful of types, and in practice only `image/png` is accepted
// everywhere, while almost every picture this app holds is a WebP — the
// compressor re-encodes to it on the way out.
//
// So the conversion happens here rather than at the call site, and the whole
// thing is one function that either works or says it did not. There is no
// silent fallback to copying a link: the object is ciphertext behind a signed
// URL that expires within the hour, and a "copied" that pastes as a dead
// address is worse than a refusal.

/** The one image type every clipboard implementation accepts. */
const CLIPBOARD_TYPE = 'image/png';

/**
 * Whether this build can copy a picture at all.
 *
 * `ClipboardItem` is missing in older WebViews and in any context the page is
 * not allowed to write to the clipboard from. Asked before the menu is drawn,
 * so a button that cannot work is never offered.
 */
export function canCopyImage(): boolean {
  return (
    typeof ClipboardItem !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard?.write === 'function'
  );
}

/** Re-encode to PNG through a canvas. Lossless from the clipboard's point of
 *  view — the pixels are already decoded by then — and it is also what strips
 *  anything the container was still carrying. */
async function toPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, CLIPBOARD_TYPE)
    );
    if (!png) throw new Error('canvas would not encode');
    return png;
  } finally {
    bitmap.close();
  }
}

/**
 * Copy a decrypted picture to the system clipboard.
 *
 * Throws rather than returning false, so the caller's catch is the one place
 * the failure is described — every other media operation in this app reports
 * its own reason and this should not be the exception.
 *
 * The `ClipboardItem` is built from a promise rather than from resolved bytes
 * on purpose: Safari discards a clipboard write that is not started in the
 * same turn as the gesture that asked for it, and awaiting the re-encode first
 * is exactly how that turn gets lost.
 */
export async function copyImage(blob: Blob): Promise<void> {
  if (!canCopyImage()) throw new Error('clipboard cannot hold an image here');
  const png = blob.type === CLIPBOARD_TYPE ? Promise.resolve(blob) : toPng(blob);
  await navigator.clipboard.write([new ClipboardItem({ [CLIPBOARD_TYPE]: png })]);
}
