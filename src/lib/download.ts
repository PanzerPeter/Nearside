// Getting a decrypted attachment out of the app and onto the device.
//
// An <a download> pointing at a blob: URL is the web answer and does nothing
// inside an Android WebView: no DownloadListener is registered, and
// DownloadManager cannot resolve the blob: scheme even if one were. That makes
// the save button inert on the only platform this app ships to.
//
// Handing the file to the share sheet instead puts a chooser between the user
// and the one thing they asked for, so saving a photo writes to the gallery
// directly.
//
// It lands in the app's own media directory (Android/media/app.nearside),
// which the media scanner indexes and every gallery app lists as an album.
// That directory needs no storage permission at any API level: asking a
// messenger for access to all your photos in order to save one of them is a
// trade this app does not make.
import { Media } from '@capacitor-community/media';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { isMobileNative } from './platform';

/** The album saved attachments appear under in the gallery. */
const GALLERY_ALBUM = 'Nearside';

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
 * The same name with its extension taken off.
 *
 * The gallery plugin appends the source file's own extension to whatever name
 * it is given, so passing the full name back would save `photo.webp.webp`.
 */
export function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Saves through the browser, the only route available off-device. */
function saveViaAnchor(blob: Blob, filename: string): void {
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
}

/**
 * Saves a text document — the data export — where the user can find it.
 *
 * Not `saveToGallery`: a JSON file is not a photo, and the gallery plugin
 * would either refuse it or file it as a broken image. `Directory.Documents`
 * is the Android equivalent of a downloads folder and needs no permission for
 * a file the app itself wrote.
 */
export async function saveTextFile(text: string, filename: string): Promise<void> {
  if (!isMobileNative()) {
    saveViaAnchor(new Blob([text], { type: 'application/json' }), filename);
    return;
  }
  await Filesystem.writeFile({
    path: filename,
    data: text,
    directory: Directory.Documents,
    encoding: Encoding.UTF8,
    recursive: true,
  });
}

/**
 * Saves `blob` to the device gallery. Resolves once the file is in the album.
 *
 * `kind` picks the plugin call rather than the destination: both land in the
 * same album, but photos and videos are registered as different media types and
 * a video filed as a photo does not play.
 */
export async function saveToGallery(
  blob: Blob,
  filename: string,
  kind: 'image' | 'video'
): Promise<void> {
  if (!isMobileNative()) {
    saveViaAnchor(blob, filename);
    return;
  }

  // Written to the cache first because the plugin copies from a path, and the
  // bytes only exist in the WebView's memory until something puts them on disk.
  const { uri } = await Filesystem.writeFile({
    path: filename,
    data: await toBase64(blob),
    directory: Directory.Cache,
  });

  try {
    const { path } = await Media.getAlbumsPath();
    try {
      await Media.createAlbum({ name: GALLERY_ALBUM });
    } catch {
      // Already there, which is the case every time after the first.
    }
    const options = {
      path: uri,
      albumIdentifier: `${path}/${GALLERY_ALBUM}`,
      fileName: stripExtension(filename),
    };
    if (kind === 'image') await Media.savePhoto(options);
    else await Media.saveVideo(options);
  } finally {
    // The copy in the album is the one that matters; leaving a second one in
    // the cache would double what every saved attachment costs on disk.
    await Filesystem.deleteFile({ path: filename, directory: Directory.Cache }).catch(() => {});
  }
}
