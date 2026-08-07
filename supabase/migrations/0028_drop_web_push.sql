/*
  Nearside — drop the Web Push transport

  Two push transports was one too many (spec §14 step 4). Background
  notifications are OneSignal's job on Android, and the VAPID path only ever
  worked in the browser build, which is a development convenience rather than a
  target. `src/lib/vapid.ts`, `src/lib/push.ts` and the service worker's push
  handlers are gone, and nothing writes this table any more.

  Dropped rather than left in place:
    An unused table full of device endpoints is a liability with no upside —
    it is the only place in this schema that stored a per-device identifier,
    and the transparency screen would have to go on describing it. A table
    described on that screen and never written to reads as a lie the moment
    someone checks.

    `TABLE_REPORTS` in src/lib/server-view.ts drops it in the same commit;
    without that, the unlisted/missing check on the transparency screen fires
    a warning at the user.

  What stays:
    `message_pushes` — the de-duplication claim, still used by both callers of
    the send-push function. `push_config` — the trigger's function URL and
    shared secret, still used by 0014's notify_push_on_message().
*/

DROP TABLE IF EXISTS public.push_subscriptions;
