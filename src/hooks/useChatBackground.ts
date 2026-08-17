import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { fileExtension } from '../lib/media';
import {
  backgroundPath,
  describeWriteError,
  forgetBackgroundUrl,
  rememberBackgroundUrl,
  reusableBackgroundUrl,
  validateBackgroundFile,
} from '../lib/background';
import { BACKGROUND_MAX_EDGE, compressImage } from '../lib/compress';
import { openFile, sealFile } from '../lib/media-crypto';
import { openForSelf, sealForSelf } from '../lib/crypto/seal';
import { fromBase64, toBase64, type Identity } from '../lib/crypto/keys';

/** How long a background's signed URL stays valid. Matches MediaAttachment. */
const SIGNED_URL_TTL = 3600;

interface BackgroundRow {
  owner_id: string;
  peer_id: string;
  media_path: string;
  /** Null on a row written before 0039, which points at a plaintext object. */
  key_ciphertext: string | null;
  key_nonce: string | null;
}

const COLUMNS = 'owner_id, peer_id, media_path, key_ciphertext, key_nonce';

/**
 * The current user's own background image for one 1:1 conversation.
 *
 * The row is keyed by (owner, peer), so the peer's choice for the same
 * conversation is a separate row that this hook never reads or writes. Setting a
 * new background replaces your row in a single upsert and deletes the previous
 * object from storage, so a conversation never accumulates images.
 *
 * The image is sealed under the owner's vault key (0039) — see
 * `lib/background.ts` for why a picture nobody else is shown still has to be.
 * The identity is needed for that, and for opening one on the way back.
 *
 * `setBackground` and `removeBackground` resolve to an error message, or null on
 * success; the caller owns how that is surfaced.
 */
export function useChatBackground(me: string, friendId: string, identity: Identity) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The current row, read synchronously by the mutators so a replacement knows
  // which object to clean up without waiting for a re-render.
  const rowRef = useRef<BackgroundRow | null>(null);
  // Every load takes a ticket and applies its result only if it is still the
  // newest. Two loads are routinely in flight — switching conversations while
  // the previous fetch is out, or a realtime change landing mid-fetch — and
  // each does two awaited round trips (row, then signed URL), so the older one
  // can easily finish last and paint the wrong chat's background.
  const loadId = useRef(0);

  /**
   * A paintable URL for one background row, or null if it cannot be produced.
   *
   * The bytes are fetched and turned into an object URL whether or not they are
   * sealed, which is what lets a row written before 0039 keep working with no
   * second code path. Handing a plaintext background its signed URL directly
   * would be one fetch cheaper and would expire after an hour — the picture
   * would vanish out of a conversation left open all afternoon, which is what
   * the old timed cache existed to work around.
   */
  const fetchBackground = useCallback(
    async (row: BackgroundRow): Promise<string | null> => {
      const { data, error } = await supabase.storage
        .from('chat-media')
        .createSignedUrl(row.media_path, SIGNED_URL_TTL);
      if (error || !data) return null;

      try {
        const response = await fetch(data.signedUrl);
        if (!response.ok) return null;
        const bytes = new Uint8Array(await response.arrayBuffer());

        if (!row.key_ciphertext || !row.key_nonce) {
          // Pre-0039: the object is the image. Kept readable rather than
          // discarded — deleting somebody's wallpaper to tidy a schema is not
          // a fix, and it is replaced the next time they set one.
          return URL.createObjectURL(new Blob([bytes]));
        }

        const key = await fromBase64(
          await openForSelf(identity.vaultKey, {
            ciphertext: row.key_ciphertext,
            nonce: row.key_nonce,
          })
        );
        // Copied, like `useSignedMediaUrl` does: `openFile` hands back a view
        // whose buffer is typed as possibly shared, which is not a `BlobPart`.
        // A background is capped at 5 MB, so the copy is free.
        const opened = await openFile(bytes, key);
        return URL.createObjectURL(new Blob([opened.slice()]));
      } catch (err) {
        // A background that will not open is a cosmetic loss, and the thread
        // behind it still works. Logged rather than raised for the same reason
        // the row read above is.
        console.error('chat background could not be opened', err);
        return null;
      }
    },
    [identity]
  );

  const load = useCallback(async (): Promise<void> => {
    const ticket = ++loadId.current;
    const apply = (row: BackgroundRow | null, signedUrl: string | null) => {
      if (loadId.current !== ticket) return;
      rowRef.current = row;
      setUrl(signedUrl);
    };

    const { data, error } = await supabase
      .from('chat_backgrounds')
      .select(COLUMNS)
      .eq('owner_id', me)
      .eq('peer_id', friendId)
      .maybeSingle();

    // A read failure is not worth a toast — the chat is still usable without a
    // background — but it must not be silent, since a missing table or grant
    // shows up here first, on open, before anyone tries to set one.
    if (error) console.error('chat background load failed', error);

    if (!data) {
      apply(null, null);
      return;
    }

    // Already fetched this session. Switching between two chats otherwise
    // re-downloads and re-decrypts both images on every tap.
    const held = reusableBackgroundUrl(data.media_path);
    if (held) {
      apply(data, held);
      return;
    }

    const url = await fetchBackground(data);
    if (url) rememberBackgroundUrl(data.media_path, url);
    // A missing object degrades to no background rather than a broken paint —
    // same posture as MediaAttachment's "no longer available" fallback.
    apply(data, url);
  }, [me, friendId, fetchBackground]);

  useEffect(() => {
    // Clear first: switching conversations must not leave the previous chat's
    // image on screen while the new row is in flight. Bumping the ticket also
    // retires any load still outstanding from the previous pair.
    loadId.current++;
    rowRef.current = null;
    setUrl(null);
    void load();
  }, [load]);

  useEffect(() => {
    const channel = supabase
      .channel(`chat-bg:${me}:${friendId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'chat_backgrounds' },
        (payload) => {
          // RLS scopes this stream to our own rows, so what arrives here is our
          // backgrounds for every conversation — hence the peer filter. It is
          // what keeps a second device of ours in step; the peer's own row is
          // invisible to us and irrelevant to this chat.
          //
          // Branch on eventType rather than `payload.new ?? payload.old`: the
          // unused half is an empty object, not undefined, so the nullish
          // fallback never fires and a DELETE would be tested against `{}` and
          // dropped. `old` is fully populated because the table is REPLICA
          // IDENTITY FULL.
          const row = (
            payload.eventType === 'DELETE' ? payload.old : payload.new
          ) as Partial<BackgroundRow>;
          if (row.owner_id !== me || row.peer_id !== friendId) return;
          void load();
        }
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [me, friendId, load]);

  const setBackground = useCallback(
    async (file: File): Promise<string | null> => {
      // Compress first, then validate: the size ceiling exists to keep a
      // backdrop cheap to decode behind every render, and a 12 MB phone photo
      // clears it comfortably once it has been re-encoded. Validating the raw
      // file would reject images that are perfectly fine to use.
      const image = await compressImage(file, { maxEdge: BACKGROUND_MAX_EDGE });
      const invalid = validateBackgroundFile(image);
      if (invalid) return invalid;

      setBusy(true);
      try {
        const previousPath = rowRef.current?.media_path ?? null;
        const path = backgroundPath(me, friendId, fileExtension(image));

        // Sealed before it is uploaded, and the key sealed before the row that
        // will carry it — everything that can fail happens while nothing has
        // been written, which is the same order `useMediaSend` sends an
        // attachment in and for the same reason.
        const { blob, key } = await sealFile(new Uint8Array(await image.arrayBuffer()));
        const sealedKey = await sealForSelf(identity.vaultKey, await toBase64(key));

        const { error: uploadError } = await supabase.storage
          .from('chat-media')
          .upload(path, blob, { contentType: blob.type });
        if (uploadError) return uploadError.message;

        // Upload first, then point the row at it, then drop the old object.
        // Any other order can leave the row referencing a file that is not
        // there yet, or already gone.
        const { error: upsertError } = await supabase
          .from('chat_backgrounds')
          .upsert(
            {
              owner_id: me,
              peer_id: friendId,
              media_path: path,
              key_ciphertext: sealedKey.ciphertext,
              key_nonce: sealedKey.nonce,
            },
            { onConflict: 'owner_id,peer_id' }
          );
        if (upsertError) {
          // Logged in full because the toast only carries the summary, and the
          // code/details/hint are what distinguish a missing migration from a
          // policy denial.
          console.error('chat background upsert failed', upsertError);
          await supabase.storage.from('chat-media').remove([path]);
          return describeWriteError(upsertError);
        }

        if (previousPath && previousPath !== path) {
          // Before the object goes, or the cache would keep handing out a URL
          // for bytes that are no longer there.
          forgetBackgroundUrl(previousPath);
          await supabase.storage.from('chat-media').remove([previousPath]);
        }
        await load();
        return null;
      } finally {
        setBusy(false);
      }
    },
    [me, friendId, load, identity]
  );

  const removeBackground = useCallback(async (): Promise<string | null> => {
    const previousPath = rowRef.current?.media_path ?? null;
    if (!previousPath) return null;

    setBusy(true);
    try {
      const { error } = await supabase
        .from('chat_backgrounds')
        .delete()
        .eq('owner_id', me)
        .eq('peer_id', friendId);
      if (error) {
        console.error('chat background delete failed', error);
        return describeWriteError(error);
      }

      // Best-effort: the row is already gone, so nothing renders it any more.
      // A leftover object is swept when either account is deleted.
      forgetBackgroundUrl(previousPath);
      await supabase.storage.from('chat-media').remove([previousPath]);
      rowRef.current = null;
      setUrl(null);
      return null;
    } finally {
      setBusy(false);
    }
  }, [me, friendId]);

  return { url, busy, setBackground, removeBackground };
}
