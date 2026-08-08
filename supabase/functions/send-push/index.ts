// send-push — notify a message's receiver, through OneSignal.
//
// Two callers, either of which is sufficient on its own:
//
//   1. The *sender's* device, fire-and-forget right after the insert:
//      supabase.functions.invoke('send-push', { body: { message_id } }).
//      Authenticated as the sender; we confirm they authored the message.
//   2. The database, from the AFTER INSERT trigger in migration 0014, over
//      pg_net with a shared secret in `x-push-secret`. This path survives the
//      sender's device being closed, offline, or on a route that can reach
//      Postgres but not the Functions host.
//
// Delivery is de-duplicated by claiming a row in `message_pushes`, so both
// callers racing produces exactly one notification, not two.
//
// **The notification never carries message content, and cannot.** After 0023
// there is no body column on `messages` — the server holds a ciphertext and a
// nonce and nothing else. Any code here reaching for the plaintext is a bug
// that fails at runtime rather than a leak, and the copy below must not imply
// otherwise. The most that can honestly be said is who it is from, and even
// that name comes from `profiles.display_name`, which the transparency screen
// declares as readable.
//
// Required Edge Function secrets (Dashboard → Edge Functions → Secrets):
//   ONESIGNAL_APP_ID      — same id the client ships (VITE_ONESIGNAL_APP_ID)
//   ONESIGNAL_REST_API_KEY — the REST key; server-side only, never in the app
//   PUSH_TRIGGER_SECRET   — only for caller (2); must equal
//                           public.push_config.trigger_secret
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected
// automatically by the Edge runtime.
//
// NOTE: caller (2) has no user JWT, so enabling it means deploying with
//   supabase functions deploy send-push --no-verify-jwt
// Authorisation then rests on the checks in this file: a request is either a
// valid user who authored the message, or a valid trigger secret. Anything
// else is rejected.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const ONESIGNAL_APP_ID = Deno.env.get("ONESIGNAL_APP_ID")?.trim();
const ONESIGNAL_REST_API_KEY = Deno.env.get("ONESIGNAL_REST_API_KEY")?.trim();
// Unset ⇒ the database-trigger path is disabled entirely.
const TRIGGER_SECRET = Deno.env.get("PUSH_TRIGGER_SECRET")?.trim();

/**
 * The Android notification channel these pushes are posted on — "Messages",
 * group "Main", in Dashboard → Settings → Push & In-App → Android Notification
 * Channels, at importance Urgent with the default sound.
 *
 * Not optional, and not a secret. On Android 8+ the sound and the heads-up
 * banner are properties of the channel, never of the payload, so a push that
 * names no channel gets whatever channel the device happens to have — which on
 * a test device was Android's invented `restored_OS_notifications` at
 * importance LOW, i.e. delivered silently. Android also refuses to raise the
 * importance of a channel it has already created, so **changing the importance
 * in the dashboard does nothing to devices that already received one push.
 * Fixing importance means creating a new channel and replacing this id.**
 */
const ANDROID_CHANNEL_ID = "93c11c0a-4c75-4c56-9c38-dd235fbed183";

/** Length-independent comparison, so a wrong secret can't be narrowed down by
 *  timing the reply. */
function secretMatches(provided: string | null): boolean {
  if (!TRIGGER_SECRET || !provided) return false;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(TRIGGER_SECRET);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * What the banner says.
 *
 * Deliberately content-free. `media_type` is a column the server does read, so
 * naming the kind of attachment is honest — but it stops there, and there is
 * no branch anywhere below that could widen it.
 */
function bodyFor(name: string, mediaType: string | null): string {
  switch (mediaType) {
    case "image":
      return `${name} sent a photo`;
    case "video":
      return `${name} sent a video`;
    case "audio":
      return `${name} sent a voice message`;
    default:
      return `New message from ${name}`;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) {
    return json({ error: "onesignal-not-configured" }, 500);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  try {
    const { message_id } = (await req.json()) as { message_id?: string };
    if (!message_id) return json({ error: "message_id required" }, 400);

    const { data: msg } = await admin
      .from("messages")
      .select("id, user_id, receiver_id, media_type")
      .eq("id", message_id)
      .maybeSingle();
    if (!msg) return json({ error: "not found" }, 404);

    // Authorise: either the trigger's shared secret, or a signed-in user who
    // actually authored this message.
    const triggerSecret = req.headers.get("x-push-secret");
    if (!secretMatches(triggerSecret)) {
      const authHeader = req.headers.get("Authorization") ?? "";
      const asUser = createClient(SUPABASE_URL, ANON, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false },
      });
      const { data: userData } = await asUser.auth.getUser();
      if (!userData?.user || userData.user.id !== msg.user_id) {
        return json({ error: "forbidden" }, 403);
      }
    }

    // A note to self is not a notification. The database trigger skips these
    // too (0017); this is the guard on the path both callers share, and it
    // must not claim the message either.
    if (msg.user_id === msg.receiver_id) return json({ skipped: "self-chat" }, 200);

    // Claim the message. The primary key makes this the single point where
    // "has this been pushed?" is decided, so the device and the database
    // trigger racing each other yields one notification rather than two.
    const { data: claim } = await admin
      .from("message_pushes")
      .upsert({ message_id: msg.id }, { onConflict: "message_id", ignoreDuplicates: true })
      .select("message_id");
    if (!claim || claim.length === 0) return json({ skipped: "already-pushed" }, 200);

    /** Give the claim back, so a later retry (or the other caller) can still
     *  deliver. A claim only sticks when it produced a notification. */
    const releaseClaim = async () => {
      await admin.from("message_pushes").delete().eq("message_id", msg.id);
    };

    const { data: sender } = await admin
      .from("profiles")
      .select("display_name")
      .eq("id", msg.user_id)
      .maybeSingle();

    // The private nickname the RECEIVER gave the sender, if any (0016). Without
    // this the banner says "@bob" while every screen in the app says "Bobby" —
    // the same person under two names, which is exactly what a nickname is for.
    // Read with the service role because the row is readable only by its owner.
    const { data: nick } = await admin
      .from("friend_nicknames")
      .select("nickname")
      .eq("owner_id", msg.receiver_id)
      .eq("peer_id", msg.user_id)
      .maybeSingle();

    const name = nick?.nickname?.trim() ||
      (sender?.display_name ? `@${sender.display_name}` : "someone");

    // Targeted by external id — the Supabase user id, set by the client's
    // `initNotifications`. Targeting the account rather than a device is what
    // makes this work across a reinstall and across two phones.
    const response = await fetch("https://api.onesignal.com/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        target_channel: "push",
        include_aliases: { external_id: [msg.receiver_id] },
        headings: { en: "Nearside" },
        contents: { en: bodyFor(name, msg.media_type) },
        android_channel_id: ANDROID_CHANNEL_ID,
        // A message someone is waiting on is not background work. Left unset,
        // FCM delivers at normal priority, which Doze may hold until the next
        // maintenance window — the notification then appears late and quietly
        // on a locked phone.
        priority: 10,
        // Stacked per sender, so a conversation reads as one entry in the
        // shade. Deliberately no `collapse_id`: that reuses one notification id
        // per sender, and OneSignal posts these with ONLY_ALERT_ONCE, so every
        // message after the first from that person updated the banner in
        // silence. A messenger that goes quiet after the first message is worse
        // than a stack of them.
        android_group: `dm:${msg.user_id}`,
        data: { senderId: msg.user_id },
      }),
    });

    const result = (await response.json().catch(() => ({}))) as {
      id?: string;
      errors?: unknown;
    };

    if (!response.ok || !result.id) {
      // No device registered *yet* — the receiver may enable notifications a
      // moment from now, and a stuck claim would silence the retry forever.
      await releaseClaim();
      return json({ sent: 0, reason: result.errors ?? response.status }, 200);
    }

    return json({ sent: 1, notification_id: result.id }, 200);
  } catch (error) {
    return json({ error: String(error) }, 500);
  }
});
