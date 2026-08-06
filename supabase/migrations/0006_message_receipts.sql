/*
  Chatly — message delivery & read receipts
  Safe to re-run in the Supabase SQL editor after 0005.

  Contents:
    1. message_receipts   — two monotonic watermarks per (user, peer) direction
    2. receipts_monotonic — trigger keeping watermarks from moving backwards
    3. unread_counts()    — per-peer unread tally, replacing localStorage
    4. Realtime           — message_receipts added to the publication
    5. Backfill           — one-time baseline for messages that predate this table

  Model:
    A row is owned by `user_id` — the person RECEIVING from `peer_id`.
    `delivered_at` means: every message peer_id sent me at or before this
    instant has reached one of my devices. `read_at` means: I have actually
    looked at them. Both are compared against messages.created_at, which is
    stamped by the SERVER clock, so clients must only ever write timestamps
    they read off a message row — never their own Date.now().

  Security notes:
    - SELECT is deliberately wider than the owner: the peer must read my
      watermarks to draw delivered/read ticks on their own sent messages.
      That exposes only two timestamps about a person you already chat with.
    - INSERT/UPDATE stay owner-only, so nobody can forge a receipt claiming
      you read something.
    - unread_counts() is SECURITY INVOKER: the existing RLS on messages does
      the scoping, so the function needs no elevated rights.
*/

-- ============================================================
-- 1. message_receipts
-- ============================================================
CREATE TABLE IF NOT EXISTS public.message_receipts (
  user_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  peer_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  delivered_at timestamptz,
  read_at      timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, peer_id),
  CONSTRAINT no_self_receipt CHECK (user_id <> peer_id)
);

-- The sender's tick lookup goes the other way round from the primary key.
CREATE INDEX IF NOT EXISTS message_receipts_peer_idx
  ON public.message_receipts (peer_id, user_id);

ALTER TABLE public.message_receipts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "receipts_select_participant" ON public.message_receipts;
CREATE POLICY "receipts_select_participant" ON public.message_receipts
  FOR SELECT TO authenticated
  USING ((select auth.uid()) IN (user_id, peer_id));

DROP POLICY IF EXISTS "receipts_insert_own" ON public.message_receipts;
CREATE POLICY "receipts_insert_own" ON public.message_receipts
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "receipts_update_own" ON public.message_receipts;
CREATE POLICY "receipts_update_own" ON public.message_receipts
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "receipts_delete_own" ON public.message_receipts;
CREATE POLICY "receipts_delete_own" ON public.message_receipts
  FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- ============================================================
-- 2. Monotonic watermarks
-- ============================================================
-- Clients race: a realtime handler and a focus handler can write in either
-- order, and an offline device flushes stale values on reconnect. Clamping
-- here means no client can un-read or un-deliver a message, so the UI never
-- shows a tick going backwards.
CREATE OR REPLACE FUNCTION public.receipts_monotonic()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.delivered_at IS NOT NULL
       AND (NEW.delivered_at IS NULL OR NEW.delivered_at < OLD.delivered_at) THEN
      NEW.delivered_at := OLD.delivered_at;
    END IF;
    IF OLD.read_at IS NOT NULL
       AND (NEW.read_at IS NULL OR NEW.read_at < OLD.read_at) THEN
      NEW.read_at := OLD.read_at;
    END IF;
  END IF;

  -- Reading something implies it reached you, so delivered can never trail
  -- read. Without this a client that only ever advances read_at would leave
  -- delivered_at null and the sender would show a single tick on a read message.
  IF NEW.read_at IS NOT NULL
     AND (NEW.delivered_at IS NULL OR NEW.delivered_at < NEW.read_at) THEN
    NEW.delivered_at := NEW.read_at;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.receipts_monotonic() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS message_receipts_monotonic ON public.message_receipts;
CREATE TRIGGER message_receipts_monotonic
  BEFORE INSERT OR UPDATE ON public.message_receipts
  FOR EACH ROW EXECUTE FUNCTION public.receipts_monotonic();

-- ============================================================
-- 3. unread_counts()
-- ============================================================
CREATE OR REPLACE FUNCTION public.unread_counts()
RETURNS TABLE (peer_id uuid, unread bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT m.user_id AS peer_id, count(*) AS unread
  FROM public.messages m
  LEFT JOIN public.message_receipts r
    ON r.user_id = (select auth.uid())
   AND r.peer_id = m.user_id
  WHERE m.receiver_id = (select auth.uid())
    AND m.deleted_at IS NULL
    AND (r.read_at IS NULL OR m.created_at > r.read_at)
  GROUP BY m.user_id;
$$;

REVOKE EXECUTE ON FUNCTION public.unread_counts() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.unread_counts() TO authenticated;

-- ============================================================
-- 4. Realtime
-- ============================================================
-- FULL replica identity so realtime can evaluate RLS against the OLD row on
-- UPDATE — same reason friendships needed it in 0004.
ALTER TABLE public.message_receipts REPLICA IDENTITY FULL;

-- Unlike CREATE ... IF NOT EXISTS, ALTER PUBLICATION ... ADD TABLE has no
-- built-in guard: a second run raises 42710 and aborts the whole script in
-- the SQL editor. Check membership first so this migration stays re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'message_receipts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.message_receipts;
  END IF;
END;
$$;

-- ============================================================
-- 5. Backfill: baseline for pre-existing conversations
-- ============================================================
-- On the day this migration first runs, message_receipts is empty, so
-- unread_counts()'s LEFT JOIN finds no row for any peer and counts every
-- non-deleted inbound message ever sent as unread — the entire lifetime
-- history of every conversation, surfaced as one giant badge. The
-- localStorage system this replaces avoided the same trap deliberately (see
-- `ensureBaseline` in src/lib/unread.ts): a first sighting anchors to "now"
-- instead of replaying the backlog. This does the equivalent server-side,
-- once: seed a read_at = now() row for every (receiver, sender) pair that
-- already has messages, so history predating receipts is treated as read.
-- ON CONFLICT DO NOTHING is not enough on its own to make this re-runnable.
-- It protects pairs that already have a row, but a genuinely unread
-- conversation created AFTER go-live has messages and no row yet — exactly the
-- shape this backfill claims. A second run would insert read_at = now() for it
-- and silently mark real unread messages as read. So the whole statement is
-- gated on the table being empty, which is the only state it was written for.
--
-- No equivalent backfill is ever needed again after this. A brand-new
-- friendship starts with no messages, so there's nothing to baseline; a
-- new *device* on an existing friendship correctly inherits the
-- server-side watermark already on this table, which is the point of
-- moving this off per-device localStorage in the first place.
-- delivered_at is left for the trigger to backfill from read_at (see the
-- unconditional clamp in receipts_monotonic above) rather than set here too.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.message_receipts) THEN
    INSERT INTO public.message_receipts (user_id, peer_id, read_at)
    SELECT DISTINCT m.receiver_id, m.user_id, now()
    FROM public.messages m
    WHERE m.deleted_at IS NULL
    ON CONFLICT (user_id, peer_id) DO NOTHING;
  END IF;
END;
$$;
