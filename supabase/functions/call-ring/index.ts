// call-ring — wake a friend's phone for an incoming call.
//
// The offer itself never comes through here. It is already on the pair's
// realtime topic, sealed, and a friend with the app open rings from that alone.
// This exists for the phone in a pocket, where the WebView is not merely
// backgrounded but gone: the push is what starts the process, and
// `CallNotificationExtension` on the Android side turns it into a ring rather
// than a banner.
//
// What it carries, and what it cannot. The payload names the caller and says a
// call is starting. It does not and could not carry anything about the call:
// there is no call row, no SDP here, no duration and no record that it
// happened — signalling is realtime broadcast, which the server relays and does
// not store. The caller's display name is the same field `send-push` already
// sends and the transparency screen already lists as readable.
//
// Authorisation is the part worth reading twice. Anyone could otherwise ring
// any account, repeatedly, from a script — a notification-spam primitive with
// no message to report. So the caller must be signed in *and* an accepted
// friend of the person being rung.
//
// Required Edge Function secrets:
//   ONESIGNAL_APP_ID       — same id the client ships (VITE_ONESIGNAL_APP_ID)
//   ONESIGNAL_REST_API_KEY — the REST key; server-side only, never in the app
//
// Deploy normally (JWT verification on): the only caller is a signed-in user.
//   supabase functions deploy call-ring

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

/**
 * The Android channel this push nominally lands on.
 *
 * Nominal because `CallNotificationExtension` intercepts it and posts its own
 * notification on the ring channel instead. It still has to name a channel: a
 * push naming none gets whatever the device invented, and on a build where the
 * extension is missing — an older APK under a newer web bundle — that is the
 * difference between a quiet banner and nothing at all.
 */
const ANDROID_CHANNEL_ID = "93c11c0a-4c75-4c56-9c38-dd235fbed183";

/** A ring is worthless late. Past this the caller has given up anyway, so the
 *  push should expire rather than arrive as a notification for a call that
 *  ended two minutes ago. */
const TTL_SECONDS = 45;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) {
    return json({ error: "onesignal-not-configured" }, 500);
  }

  try {
    const { peer_id, call_id, kind } = (await req.json()) as {
      peer_id?: string;
      call_id?: string;
      kind?: string;
    };
    if (!peer_id || !call_id) return json({ error: "peer_id and call_id required" }, 400);

    const asUser = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
      auth: { persistSession: false },
    });
    const { data: userData } = await asUser.auth.getUser();
    const caller = userData?.user?.id;
    if (!caller) return json({ error: "forbidden" }, 403);
    if (caller === peer_id) return json({ skipped: "self" }, 200);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false },
    });

    // Accepted in either direction — the row is written once, by whichever of
    // the two sent the request, and both halves of the pair may call.
    const { data: friendship } = await admin
      .from("friendships")
      .select("id")
      .eq("status", "accepted")
      .or(
        `and(requester_id.eq.${caller},addressee_id.eq.${peer_id}),` +
          `and(requester_id.eq.${peer_id},addressee_id.eq.${caller})`
      )
      .maybeSingle();
    if (!friendship) return json({ error: "not-a-contact" }, 403);

    const { data: profile } = await admin
      .from("profiles")
      .select("display_name")
      .eq("id", caller)
      .maybeSingle();

    // The private nickname the receiver gave the caller (0016). Without it the
    // ring says "@bob" while every screen in the app says "Bobby". Read with
    // the service role, since the row is readable only by its owner.
    const { data: nick } = await admin
      .from("friend_nicknames")
      .select("nickname")
      .eq("owner_id", peer_id)
      .eq("peer_id", caller)
      .maybeSingle();

    const name =
      nick?.nickname?.trim() || (profile?.display_name ? `@${profile.display_name}` : "Someone");
    const video = kind === "video";

    const response = await fetch("https://api.onesignal.com/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        target_channel: "push",
        // Targeted by external id, like every other push here: the account
        // rather than a device, which is what reaches someone holding two
        // phones and survives a reinstall.
        include_aliases: { external_id: [peer_id] },
        headings: { en: name },
        contents: { en: video ? "Incoming video call" : "Incoming voice call" },
        android_channel_id: ANDROID_CHANNEL_ID,
        priority: 10,
        // High-priority *data*: the extension needs this delivered while the
        // app is dead, and Doze holds a normal-priority push until the next
        // maintenance window — by which time the caller has hung up.
        android_visibility: 1,
        ttl: TTL_SECONDS,
        // What CallNotificationExtension reads. `type` is what tells it this is
        // a ring rather than a message; without it the push displays as an
        // ordinary banner, which is also the correct behaviour on an older APK.
        data: {
          type: "call",
          callId: call_id,
          peerId: caller,
          peerName: name,
          kind: video ? "video" : "voice",
        },
      }),
    });

    const result = (await response.json().catch(() => ({}))) as {
      id?: string;
      errors?: unknown;
    };
    if (!response.ok || !result.id) {
      // No device registered, or notifications declined. Not a failure worth
      // ending the call over: the realtime topic is still carrying the offer,
      // so a friend with the app open rings regardless.
      return json({ sent: 0, reason: result.errors ?? response.status }, 200);
    }
    return json({ sent: 1, notification_id: result.id }, 200);
  } catch (error) {
    return json({ error: String(error) }, 500);
  }
});
