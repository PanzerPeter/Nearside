/*
  Nearside — the thumbnail 0044 did not finish

  Applied after 0050. No new table, no new column, no new policy and no new
  disclosure: two places 0044 should have taught about `media_thumb_path` and
  did not.

  ---------------------------------------------------------------------------
  1. The expiry sweep left every preview behind.

  `expire_messages()` collects `media_path` before it deletes the rows, because
  the row holds the only copy of the file key and a disappearing message that
  leaves its picture in the bucket has not disappeared. 0044 gave every
  attachment a SECOND object — the small sealed copy the bubble draws — and did
  not add it here. So since 0044 every expiring photo and video has deleted its
  full-size object and orphaned its preview.

  What is left is not readable: the thumbnail is sealed under the same per-file
  key as the attachment, and that key died with the row. It is a listing that
  grows and nothing that will ever collect it — an unbounded storage bill for
  the one feature whose whole promise is that the thing goes away.

  Both other places that own this rule already state it. `trimOldMedia` in
  src/hooks/useMediaSend.ts removes both paths and says why: "A thumbnail whose
  attachment was collected is bytes in the bucket that nothing points at and
  nothing will ever collect." And the CHECK that 0044 put on `messages` says
  the collector "walks media_path". It does. That was the bug.

  Nothing is backfilled. The orphans already in `chat-media` are unreachable
  from any row — that is what makes them orphans — so collecting them means
  listing the bucket and subtracting the paths still referenced. That is a job
  for `maintenance/`, run once by a human against a project, not for a
  migration that must be safe to replay.

  The sweep is unchanged in every other respect, including the connect-token
  collection 0042 added: a plpgsql function is replaced whole, so the rest of
  the body is carried over verbatim to keep this and `schema.sql` one thing.

  ---------------------------------------------------------------------------
  2. `room_messages_body_guard` never learned the column either.

  0044 replaced `messages_body_guard` and named the failure exactly: a
  thumbnail path was "a piece of content the guard did not consider content: it
  could be set on a deleted message, and repointed on a live one without the
  row ever reading as edited". It did not replace the room twin.

  Half of that is covered in both tables already — `media_thumb_needs_media`
  refuses a thumbnail on a row that names no attachment, and a tombstone names
  none — so the tombstone clause is parity rather than a hole, exactly as it is
  on `messages`. The other half is open in rooms and closed in 1:1: the sender
  of a room message can repoint its preview and the row never stamps
  `edited_at`. `sig_v` 3 puts `media_thumb_path` inside the signature, so the
  sender re-signs and every client verifies it happily; the picture in the
  bubble changes and nothing says it changed.

  No client path does this — `sendMedia` writes both paths once and
  `deleteRoomMessage` nulls both — so this is an integrity gap rather than a
  bug report. It is the gap 0044 judged worth closing, closed in the other
  table.
*/

-- ------------------------------------------------- the sweep takes both paths

CREATE OR REPLACE FUNCTION public.expire_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  doomed text[];
BEGIN
  -- Both objects per row (0051). `unnest` rather than four UNION branches, so
  -- the pair stays written once per table and a third object — if one is ever
  -- added — is one more element rather than one more branch.
  SELECT coalesce(array_agg(path), '{}')
    INTO doomed
    FROM (
      SELECT unnest(ARRAY[media_path, media_thumb_path]) AS path
        FROM public.messages
       WHERE expires_at IS NOT NULL AND expires_at <= now() AND media_path IS NOT NULL
      UNION ALL
      SELECT unnest(ARRAY[media_path, media_thumb_path])
        FROM public.room_messages
       WHERE expires_at IS NOT NULL AND expires_at <= now() AND media_path IS NOT NULL
    ) expiring
   -- Null on a voice note and on every row written before 0044.
   WHERE expiring.path IS NOT NULL;

  DELETE FROM public.messages      WHERE expires_at IS NOT NULL AND expires_at <= now();
  DELETE FROM public.room_messages WHERE expires_at IS NOT NULL AND expires_at <= now();

  -- Spent and expired connect codes (0042). Expiry, not tidying: a token past
  -- `expires_at` is one `redeem_connect_code` already refuses, so nothing is
  -- taken away. Used codes are reachable only through this condition, which is
  -- what stops a redeemed code being minted again while it is still live.
  DELETE FROM public.connect_tokens WHERE expires_at < now();

  -- Best effort. The rows above held the only copies of these files' keys, so
  -- the bytes are already unopenable; this reclaims the listing.
  IF array_length(doomed, 1) > 0 THEN
    DELETE FROM storage.objects
     WHERE bucket_id = 'chat-media' AND name = ANY (doomed);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_messages() FROM PUBLIC, anon, authenticated;

-- --------------------------------------- the room body guard learns it too

CREATE OR REPLACE FUNCTION public.room_messages_body_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    IF NEW.deleted_at IS NULL THEN
      RAISE EXCEPTION 'a deleted message cannot be restored';
    END IF;
    IF NEW.ciphertext IS NOT NULL
       OR NEW.media_path IS NOT NULL
       OR NEW.media_thumb_path IS NOT NULL THEN
      RAISE EXCEPTION 'a deleted message cannot be given a new body';
    END IF;
  END IF;

  IF NEW.deleted_at IS NULL
     AND (NEW.ciphertext IS DISTINCT FROM OLD.ciphertext
          OR NEW.media_path IS DISTINCT FROM OLD.media_path
          OR NEW.media_thumb_path IS DISTINCT FROM OLD.media_thumb_path) THEN
    NEW.edited_at := now();
  END IF;

  NEW.expires_at := OLD.expires_at;
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.room_messages_body_guard() FROM PUBLIC, anon, authenticated;
