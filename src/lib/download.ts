// Getting a decrypted attachment out of the app and onto the device.
//
// An <a download> pointing at a blob: URL is the web answer and does nothing
// at all inside an Android WebView: there is no DownloadListener registered,
// and DownloadManager cannot resolve the blob: scheme even if there were. The
// download button on every attachment was therefore inert on the only platform
// this app ships to.
//
// On native the bytes are written to the app's cache and handed to the system
// share sheet, which is where "Save to Files", Drive and everything else live.
// Cache rather than a public directory on purpose: no storage permission is
// involved, and the copy is the OS's to clean up once the user has put it
// somewhere they chose.
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

/** The `data:` prefix a FileReader result carries, up to and including the comma. */
const DATA_URL_PREFIX = /^data:[^;]*;base64,/;

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.replace(DATA_URL_PREFIX, '');
      // A zero-length file reads back as a bare prefix and would otherwise be
      // written as the literal string "undefined".
      resolve(comma === result ? '' : comma);
    };
    reader.readAsDataURL(blob);
  });
}

/** A filesystem-safe name from a storage object path. */
export function downloadName(path: string, fallback: string): string {
  const base = path.split('/').pop() ?? '';
  const cleaned = base.replace(/[^\w.-]/g, '_');
  return cleaned && cleaned !== '.' ? cleaned : fallback;
}

/**
 * Saves `blob` under `filename`. Resolves once the file has been handed over;
 * on native that means the share sheet has been shown, not that the user chose
 * anything — which sheet they pick is not ours to know.
 */
export async function saveBlob(blob: Blob, filename: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Not revoked synchronously: several browsers cancel an in-flight download
    // when its blob is released in the same tick as the click.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }

  const { uri } = await Filesystem.writeFile({
    path: filename,
    data: await toBase64(blob),
    directory: Directory.Cache,
  });
  await Share.share({ title: filename, files: [uri] });
}
