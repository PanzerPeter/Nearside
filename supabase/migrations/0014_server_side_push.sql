/*
  Nearside — server-side push delivery
  Run once in the Supabase SQL editor after 0013. See supabase/SETUP.md.

  Why:
    Until now a push notification was only ever triggered by the *sender's*
    browser, fire-and-forget, immediately after the insert. That misses every
    case where the sender's browser doesn't survive the request:

      - send a message, lock the phone → the invoke is aborted mid-flight
      - the sender's network drops the moment after the insert commits
      - the Edge Function endpoint is unreachable *for the sender* while the
        database is not (a proxied, filtered or censored route)

    In each case the message is stored and the receiver is never told. Moving
    the trigger to the database makes delivery independent of the sender's
    browser surviving long enough to ask.

  Contents:
    1. message_pushes  — one row per message that has been pushed, so the
                         database trigger and the browser's own invoke can
                         both fire without the receiver getting two banners
    2. push_config     — where to call, and the shared secret to call with
    3. notify_push_on_message — AFTER INSERT trigger using pg_net

  This migration is OPT-IN and inert until `push_config` holds a row. Without
  one the trigger returns immediately, so applying it changes nothing until
  you have deployed the matching send-push function. See SETUP.md.
*/

-- pg_net issues the HTTP call asynchronously, off the inserting transaction.
-- It creates and owns the `net` schema, so no WITH SCHEMA clause here.
CREATE EXTENSION IF NOT EXISTS pg_net;

/* ---------------------------------------------------------------------------
   1. Push de-duplication
--------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.message_pushes (
  message_id uuid PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  sent_at    timestamptz NOT NULL DEFAULT now()
);

-- Service-role only. No policies are defined, and RLS is on, so no client can
-- read or write this table — it exists purely for the Edge Function's claim.
ALTER TABLE public.message_pushes ENABLE ROW LEVEL SECURITY;

/* ---------------------------------------------------------------------------
   2. Trigger configuration

   A table rather than a database setting: `ALTER DATABASE ... SET` needs
   privileges the Supabase SQL editor does not hand out, and Vault would tie
   this migration to a specific project's key ids.
--------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.push_config (
  id            boolean PRIMARY KEY DEFAULT true CHECK (id),
  function_url  text NOT NULL,
  trigger_secret text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Holds a secret: service role only, same as above. RLS on, no policies.
ALTER TABLE public.push_config ENABLE ROW LEVEL SECURITY;

/* ---------------------------------------------------------------------------
   3. The trigger
--------------------------------------------------------------------------- */

CREATE OR REPLACE FUNCTION public.notify_push_on_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  cfg public.push_config%ROWTYPE;
BEGIN
  -- Soft-deleted on arrival shouldn't notify; nor should anything before the
  -- function has been configured.
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO cfg FROM public.push_config LIMIT 1;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := cfg.function_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-push-secret', cfg.trigger_secret
               ),
    body    := jsonb_build_object('message_id', NEW.id),
    timeout_milliseconds := 5000
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A notification is never worth failing a send over. If the HTTP call can't
  -- be queued the message still stores, and the sender's own invoke (which is
  -- still in place) remains as the second path.
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notify_push_on_message ON public.messages;
CREATE TRIGGER notify_push_on_message
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.notify_push_on_message();
