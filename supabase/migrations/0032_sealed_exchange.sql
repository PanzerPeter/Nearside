/*
  Nearside — sealed exchange

  Applied after 0031. Adds the one thing in this app that is not a variation
  on a messenger feature: a question whose answers stay unreadable to both
  sides until both sides have answered.

  The problem it solves is that a fair exchange between two parties who do not
  trust each other is impossible without a referee — whoever reads second can
  always read and then walk away. So there is a referee, and it is the server,
  and the entire point of the design below is that the referee learns nothing.

  How it works:

  - The question is an ordinary `messages` row with `sealed_prompt` set. It is
    sealed to the peer like every other body; both sides can read it at once,
    which is what makes it a question rather than a puzzle.

  - Each answer is a row in `sealed_answers`, sealed to the peer with the same
    crypto_box the body uses. The server holds two ciphertexts it cannot open.

  - The SELECT policy releases the peer's answer to you only once your own
    answer exists. That policy is the feature. Nothing in the client enforces
    it, because a client that enforces it can be patched — this repository is
    public, and "the app hides it from you" is not a guarantee.

  - There is no UPDATE policy and no UPDATE grant. An answer is immutable once
    written, which is what stops "answer, read theirs, then revise mine".

  - There is no DELETE policy either. Cancelling a question tombstones the
    `messages` row through the ordinary delete path, and the INSERT policy
    refuses to answer a tombstoned prompt, so a cancelled question can never
    be made to release the asker's answer afterwards.

  What it does not defend against: answering with garbage to force the reveal.
  That is possible and it is permanent — the garbage is immutable and sits in
  the thread under your name. SECURITY.md says so rather than implying the
  protocol is tighter than it is.

  Self-chat is excluded. An exchange with yourself has nothing to withhold.
*/

-- ---------------------------------------------------------------------------
-- The question
-- ---------------------------------------------------------------------------

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS sealed_prompt boolean NOT NULL DEFAULT false;

/*
  A prompt is text and only text. Media would need a second reveal path (the
  file key is in the row, so the attachment opens the moment the row does), and
  a prompt that reveals half of itself early is worse than no prompt.
*/
ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS sealed_prompt_shape;
ALTER TABLE public.messages
  ADD CONSTRAINT sealed_prompt_shape CHECK (
    NOT sealed_prompt
    OR (ciphertext IS NOT NULL AND media_path IS NULL AND user_id <> receiver_id)
  );

/*
  Frozen alongside `forwarded`. A row that could be flipped into a prompt after
  the fact — or out of one — would let the asker change what the answers were
  answering.
*/
CREATE OR REPLACE FUNCTION public.messages_prevent_reassign()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.receiver_id IS DISTINCT FROM OLD.receiver_id THEN
    RAISE EXCEPTION 'messages.user_id and messages.receiver_id are immutable';
  END IF;
  IF NEW.forwarded IS DISTINCT FROM OLD.forwarded THEN
    RAISE EXCEPTION 'messages.forwarded is immutable';
  END IF;
  IF NEW.sealed_prompt IS DISTINCT FROM OLD.sealed_prompt THEN
    RAISE EXCEPTION 'messages.sealed_prompt is immutable';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.messages_prevent_reassign() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The answers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sealed_answers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id  uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  ciphertext text NOT NULL,
  nonce      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- One answer each. Without it the INSERT policy would let a participant
  -- stack answers, and "which one is theirs" has no good answer.
  CONSTRAINT sealed_answers_one_each UNIQUE (prompt_id, user_id)
);

CREATE INDEX IF NOT EXISTS sealed_answers_prompt_idx
  ON public.sealed_answers (prompt_id);

/*
  SECURITY DEFINER because the SELECT policy on `sealed_answers` has to ask a
  question about `sealed_answers`. Written inline as an EXISTS it recurses:
  evaluating the policy runs the subquery, which evaluates the policy. A
  definer-rights function is not subject to RLS and so terminates.

  It answers one bit — "has this person answered this prompt" — for any pair of
  arguments, and that bit is already implied by what the caller can see, so
  widening it to `authenticated` costs nothing.
*/
CREATE OR REPLACE FUNCTION public.has_answered(prompt uuid, who uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.sealed_answers a
    WHERE a.prompt_id = prompt AND a.user_id = who
  );
$$;

REVOKE ALL ON FUNCTION public.has_answered(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_answered(uuid, uuid) TO authenticated;

ALTER TABLE public.sealed_answers ENABLE ROW LEVEL SECURITY;

/*
  The feature, in four lines.

  Your own answer is always yours to read — the client needs it to render your
  side while it waits. Anyone else's is released only once you have committed
  one of your own. A non-participant satisfies neither branch: they cannot have
  an answer row (the INSERT policy stops that), so `has_answered` is false for
  them and the first branch never matches.
*/
DROP POLICY IF EXISTS "sealed_answers_select_after_own" ON public.sealed_answers;
CREATE POLICY "sealed_answers_select_after_own" ON public.sealed_answers
  FOR SELECT TO authenticated
  USING (
    user_id = (select auth.uid())
    OR public.has_answered(prompt_id, (select auth.uid()))
  );

/*
  You may answer a live prompt in a conversation you are part of, as yourself.

  `deleted_at IS NULL` is what makes cancelling final: the ordinary delete path
  tombstones the prompt, and a tombstoned prompt can no longer be answered, so
  the asker's answer can never be unlocked after they withdrew the question.
*/
DROP POLICY IF EXISTS "sealed_answers_insert_participant" ON public.sealed_answers;
CREATE POLICY "sealed_answers_insert_participant" ON public.sealed_answers
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (select auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = prompt_id
        AND m.sealed_prompt
        AND m.deleted_at IS NULL
        AND m.user_id <> m.receiver_id
        AND (select auth.uid()) IN (m.user_id, m.receiver_id)
    )
  );

/*
  No UPDATE and no DELETE, as policies or as grants. Immutability is half the
  protocol: an answer that can be edited after the reveal is not an answer that
  was committed before it, and one that can be withdrawn lets the second player
  read and then take the reveal back. Rows still disappear with their prompt —
  a cascade runs as the table owner and is not subject to RLS.
*/
REVOKE ALL ON public.sealed_answers FROM anon;
REVOKE ALL ON public.sealed_answers FROM authenticated;
GRANT SELECT, INSERT ON public.sealed_answers TO authenticated;

-- ---------------------------------------------------------------------------
-- Asking, as one transaction
-- ---------------------------------------------------------------------------

/*
  Two inserts from the client would leave a window in which the question exists
  and the asker has not answered it. The peer could answer into that window,
  unlocking nothing and being left with a permanent answer to a question whose
  other half never arrived.

  SECURITY INVOKER, deliberately: every policy above still applies, the rate
  limit still fires, and the expiry trigger still stamps. The only thing this
  buys is that both rows land or neither does.

  The id comes from the client, as the outbox's do, so a retry after a lost
  response collides on the primary key rather than asking twice.
*/
CREATE OR REPLACE FUNCTION public.ask_sealed(
  prompt_id         uuid,
  receiver          uuid,
  prompt_ciphertext text,
  prompt_nonce      text,
  answer_ciphertext text,
  answer_nonce      text
)
RETURNS public.messages
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  msg public.messages;
BEGIN
  INSERT INTO public.messages (id, user_id, receiver_id, ciphertext, nonce, sealed_prompt)
  VALUES (prompt_id, (select auth.uid()), receiver, prompt_ciphertext, prompt_nonce, true)
  RETURNING * INTO msg;

  INSERT INTO public.sealed_answers (prompt_id, user_id, ciphertext, nonce)
  VALUES (msg.id, (select auth.uid()), answer_ciphertext, answer_nonce);

  RETURN msg;
END;
$$;

REVOKE ALL ON FUNCTION public.ask_sealed(uuid, uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ask_sealed(uuid, uuid, text, text, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

/*
  INSERT events only, which carry the new record, so the SELECT policy can be
  evaluated against it and REPLICA IDENTITY FULL is unnecessary. The event that
  matters is the peer's answer landing: it is the moment both sides open.
*/
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'sealed_answers'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sealed_answers;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
