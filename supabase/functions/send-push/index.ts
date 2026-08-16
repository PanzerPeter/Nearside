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
// The notification never carries message content, and cannot: after 0023
// `messages` holds a ciphertext and a nonce and no body column, so code here
// reaching for plaintext fails at runtime rather than leaking. The copy below
// must not imply otherwise. Who it is from is the most that can be said, and
// that name comes from `profiles.display_name`, which the transparency screen
// already declares readable.
//
// Required Edge Function secrets (Dashboard → Edge Functions → Secrets):
//   ONESIGNAL_APP_ID      — same id the client ships (VITE_ONESIGNAL_APP_ID)
//   ONESIGNAL_REST_API_KEY — the REST key; server-side only, never in the app
//   PUSH_TRIGGER_SECRET   — only for caller (2); must equal
//                           public.push_config.trigger_secret
//   ONESIGNAL_QUIET_CHANNEL_ID — optional. The Android channel a message
//                           inside the alert cooldown is posted on: same group
//                           as the loud one, importance Low, no sound. Unset,
//                           every notification alerts, which is what this
//                           function did before the cooldown existed.
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
 * The Android notification channel these pushes post on: "Messages", group
 * "Main", importance Urgent with the default sound, under Dashboard →
 * Settings → Push & In-App → Android Notification Channels.
 *
 * Required, and not a secret. On Android 8+ the sound and the heads-up banner
 * belong to the channel rather than the payload, so a push naming no channel
 * gets whatever the device has: on one test device, Android's invented
 * `restored_OS_notifications` at importance LOW, delivered silently. Android
 * also refuses to raise the importance of a channel it has already created, so
 * changing importance in the dashboard does nothing to devices that have
 * received a push. Fixing it means a new channel and a new id here.
 */
const ANDROID_CHANNEL_ID = "93c11c0a-4c75-4c56-9c38-dd235fbed183";

/**
 * The quiet twin of the channel above: same group, importance Low, no sound.
 *
 * A second channel rather than a field on the payload, because on Android 8+
 * there is no field to set — sound and heads-up belong to the channel, so the
 * only silent notification is one posted on a silent channel. Low keeps it out
 * of the banner and out of the speaker while still landing in the shade, which
 * is the point: the message is still there to see, it just does not interrupt
 * twice in the same minute.
 *
 * Unset ⇒ everything alerts, which is the behaviour this file had before. A
 * missing channel id would otherwise mean the *device* picks, and Android's
 * fallback is a channel it invents at importance Low that the user cannot find
 * to fix.
 */
const ANDROID_QUIET_CHANNEL_ID = Deno.env.get("ONESIGNAL_QUIET_CHANNEL_ID")?.trim();

/**
 * How long a conversation stays quiet after it has alerted.
 *
 * Stated a second time here: the client's copy is `ALERT_COOLDOWN_MS` in
 * `src/lib/alert-throttle.ts`, which governs the in-app chime on desktop, and
 * this runtime is Deno with no path to `src/`. If one moves, move both.
 */
const ALERT_COOLDOWN_MS = 30_000;

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
 * What the banner says. Content-free by construction. `media_type` is a column
 * the server does read, so naming the kind of attachment is honest, and no
 * branch below widens it beyond that.
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

    // The private nickname the receiver gave the sender, if any (0016).
    // Without it the banner says "@bob" while every screen in the app says
    // "Bobby". Read with the service role, since the row is readable only by
    // its owner.
    const { data: nick } = await admin
      .from("friend_nicknames")
      .select("nickname")
      .eq("owner_id", msg.receiver_id)
      .eq("peer_id", msg.user_id)
      .maybeSingle();

    const name = nick?.nickname?.trim() ||
      (sender?.display_name ? `@${sender.display_name}` : "someone");

    // Alert, or arrive quietly. A conversation is a burst of short messages,
    // and a sound for each of them is a phone buzzing six times while somebody
    // finishes a sentence. The first one rings; the rest of the burst still
    // appears in the shade, still raises the count, and makes no noise.
    //
    // The anchor is the last notification that *rang*, not the last one sent —
    // see `0035_push_alerts` for why the difference matters.
    const { data: anchor } = await admin
      .from("push_alerts")
      .select("alerted_at")
      .eq("receiver_id", msg.receiver_id)
      .eq("sender_id", msg.user_id)
      .maybeSingle();

    const now = Date.now();
    const lastAlert = anchor?.alerted_at ? Date.parse(anchor.alerted_at) : NaN;
    // An unreadable or missing stamp rings, and so does one in the future: a
    // clock that went backwards must not silence a conversation for good.
    const due = !Number.isFinite(lastAlert) ||
      now < lastAlert ||
      now - lastAlert >= ALERT_COOLDOWN_MS;
    // Without a quiet channel configured there is nowhere silent to post, and
    // a notification nobody hears about is worse than one heard twice.
    const quiet = !due && !!ANDROID_QUIET_CHANNEL_ID;

    // Targeted by external id: the Supabase user id, set by the client's
    // `initNotifications`. Addressing the account rather than a device is what
    // survives a reinstall and reaches someone holding two phones.
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
        android_channel_id: quiet ? ANDROID_QUIET_CHANNEL_ID : ANDROID_CHANNEL_ID,
        // The iOS half of the same decision. `passive` files the notification
        // without a sound or a banner; the channel does that job on Android and
        // has no counterpart here.
        ios_interruption_level: quiet ? "passive" : "active",
        // A message someone is waiting on is not background work. Unset, FCM
        // delivers at normal priority and Doze may hold it until the next
        // maintenance window, so it arrives late and quietly on a locked phone.
        // A quiet one is still a message someone is waiting on — the silence is
        // the channel's doing, and delaying delivery on top of it would mean a
        // burst landing minutes after the conversation moved on.
        priority: 10,
        // Stacked per sender, so a conversation reads as one entry in the
        // shade. No `collapse_id`: that reuses one notification id per sender,
        // and OneSignal posts with ONLY_ALERT_ONCE, so every message after the
        // first would update the banner in silence.
        android_group: `dm:${msg.user_id}`,
        data: { senderId: msg.user_id },
      }),
    });

    const result = (await response.json().catch(() => ({}))) as {
      id?: string;
      errors?: unknown;
    };

    if (!response.ok || !result.id) {
      // No device registered yet. The receiver may enable notifications a
      // moment from now, and a stuck claim would silence the retry forever.
      await releaseClaim();
      return json({ sent: 0, reason: result.errors ?? response.status }, 200);
    }

    // Moved only once the notification is actually out, and only when it made a
    // sound. Stamped before the send, a delivery that failed would still close
    // the window and the retry would arrive silent.
    if (!quiet) {
      await admin
        .from("push_alerts")
        .upsert(
          {
            receiver_id: msg.receiver_id,
            sender_id: msg.user_id,
            alerted_at: new Date(now).toISOString(),
          },
          { onConflict: "receiver_id,sender_id" },
        );
    }

    return json({ sent: 1, notification_id: result.id, quiet }, 200);
  } catch (error) {
    return json({ error: String(error) }, 500);
  }
});
