import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { fileExtension } from '../lib/conversation';
import {
  backgroundPath,
  describeWriteError,
  forgetBackgroundUrl,
  rememberBackgroundUrl,
  reusableBackgroundUrl,
  validateBackgroundFile,
} from '../lib/background';
import { BACKGROUND_MAX_EDGE, compressImage } from '../lib/compress';

/** How long a background's signed URL stays valid. Matches MediaAttachment. */
const SIGNED_URL_TTL = 3600;

interface BackgroundRow {
  owner_id: string;
  peer_id: string;
  media_path: string;
}

/**
 * The current user's own background image for one 1:1 conversation.
 *
 * The row is keyed by (owner, peer), so the peer's choice for the same
 * conversation is a separate row that this hook never reads or writes. Setting a
 * new background replaces your row in a single upsert and deletes the previous
 * object from storage, so a conversation never accumulates images.
 *
 * `setBackground` and `removeBackground` resolve to an error message, or null on
 * success; the caller owns how that is surfaced.
 */
export function useChatBackground(me: string, friendId: string) {
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

  const load = useCallback(async (): Promise<void> => {
    const ticket = ++loadId.current;
    const apply = (row: BackgroundRow | null, signedUrl: string | null) => {
      if (loadId.current !== ticket) return;
      rowRef.current = row;
      setUrl(signedUrl);
    };

    const { data, error } = await supabase
      .from('chat_backgrounds')
      .select('owner_id, peer_id, media_path')
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

    // Reuse the last signature for this object while it is still good. A new
    // one is a new URL, which the browser has to fetch even though the image
    // behind it is byte-for-byte what it painted a second ago.
    const reusable = reusableBackgroundUrl(data.media_path);
    if (reusable) {
      apply(data, reusable);
      return;
    }

    const { data: signed } = await supabase.storage
      .from('chat-media')
      .createSignedUrl(data.media_path, SIGNED_URL_TTL);
    if (signed?.signedUrl) rememberBackgroundUrl(data.media_path, signed.signedUrl);
    // A missing object degrades to no background rather than a broken paint —
    // same posture as MediaAttachment's "no longer available" fallback.
    apply(data, signed?.signedUrl ?? null);
  }, [me, friendId]);

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

        const { error: uploadError } = await supabase.storage
          .from('chat-media')
          .upload(path, image, { contentType: image.type });
        if (uploadError) return uploadError.message;

        // Upload first, then point the row at it, then drop the old object.
        // Any other order can leave the row referencing a file that is not
        // there yet, or already gone.
        const { error: upsertError } = await supabase
          .from('chat_backgrounds')
          .upsert(
            { owner_id: me, peer_id: friendId, media_path: path },
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
          // Before the object goes, or the reuse window would keep handing out
          // a URL to bytes that are no longer there.
          forgetBackgroundUrl(previousPath);
          await supabase.storage.from('chat-media').remove([previousPath]);
        }
        await load();
        return null;
      } finally {
        setBusy(false);
      }
    },
    [me, friendId, load]
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
