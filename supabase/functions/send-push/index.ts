// send-push — notify a message's receiver (or a room's members), through
// OneSignal.
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
//   ONESIGNAL_QUIET_CHANNEL_ID — optional. The Android channel a message the
//                           alert ladder is holding quiet is posted on: same
//                           group as the loud one, importance Low, no sound.
//                           Unset, every notification alerts, which is what
//                           this function did before the ladder existed.
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
 * How long a conversation stays quiet after it has alerted, by how many times
 * it has already rung without being caught up.
 *
 * Stated a second time here: the client's copy is `ALERT_LADDER_MS` in
 * `src/lib/alert-throttle.ts`, which governs the in-app chime on desktop, and
 * this runtime is Deno with no path to `src/`. If one moves, move both. That
 * file also carries the reasoning; the short version is that one sound per
 * thirty seconds turned a six-message burst into a single chime and then spent
 * its next one after the burst was over, so the ladder rings two or three times
 * while the conversation is actually happening and then settles down.
 */
const ALERT_LADDER_MS = [0, 5_000, 15_000, 40_000];

/** Silence long enough that the next message starts the ladder over. */
const ALERT_IDLE_RESET_MS = 5 * 60_000;

interface AlertAnchor {
  alertedAt: number;
  streak: number;
}

/**
 * Whether a message arriving now should make a noise, and the streak to store
 * if it does.
 *
 * `readAt` is the receiver's read watermark for this conversation — millis, or
 * NaN when they have never read it. Once it passes the message we last rang
 * about, the next thing that arrives is a new turn rather than the tail of a
 * burst and rings like a first message; without it, reading a chat and putting
 * the phone down bought silence for a reply that had every right to be heard.
 *
 * An unreadable, missing or future anchor rings and starts over: a clock that
 * went backwards must not silence a conversation for good.
 */
function decideAlert(
  anchor: AlertAnchor | null,
  now: number,
  readAt: number,
): { alerting: boolean; streak: number } {
  if (!anchor || !Number.isFinite(anchor.alertedAt)) return { alerting: true, streak: 1 };

  const caughtUp = Number.isFinite(readAt) && readAt >= anchor.alertedAt;
  const idle = now - anchor.alertedAt >= ALERT_IDLE_RESET_MS;
  if (caughtUp || idle || now < anchor.alertedAt) return { alerting: true, streak: 1 };

  const gap = ALERT_LADDER_MS[Math.min(anchor.streak, ALERT_LADDER_MS.length - 1)];
  if (now - anchor.alertedAt < gap) return { alerting: false, streak: anchor.streak };
  return { alerting: true, streak: Math.min(anchor.streak + 1, ALERT_LADDER_MS.length) };
}

/** A stored anchor row, tolerant of a missing or unparseable stamp. */
function anchorFrom(
  alertedAt: string | null | undefined,
  streak: number | null | undefined,
): AlertAnchor | null {
  if (!alertedAt) return null;
  const at = Date.parse(alertedAt);
  if (!Number.isFinite(at)) return null;
  return { alertedAt: at, streak: Number.isFinite(streak) ? Number(streak) : 1 };
}

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

/**
 * A room message, fanned out to every other member.
 *
 * Separate from the 1:1 path below rather than folded into it: the audience is
 * a participant list instead of one column, the claim and the cooldown live in
 * different tables (see 0037), and the banner names a room instead of a
 * person. Sharing a code path between those would be sharing four `if`s.
 *
 * The name is `profiles.display_name`, never the receiver's private nickname
 * for the sender: one notification addresses many people at once, and reading
 * each receiver's nicknames to personalise it would mean one OneSignal call
 * per member of every room.
 */
async function pushRoomMessage(
  admin: ReturnType<typeof createClient>,
  req: Request,
  roomMessageId: string,
): Promise<Response> {
  const { data: msg } = await admin
    .from("room_messages")
    .select("id, room_id, sender_id, media_type, deleted_at")
    .eq("id", roomMessageId)
    .maybeSingle();
  if (!msg) return json({ error: "not found" }, 404);
  if (msg.deleted_at) return json({ skipped: "deleted" }, 200);

  const triggerSecret = req.headers.get("x-push-secret");
  if (!secretMatches(triggerSecret)) {
    const authHeader = req.headers.get("Authorization") ?? "";
    const asUser = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: userData } = await asUser.auth.getUser();
    if (!userData?.user || userData.user.id !== msg.sender_id) {
      return json({ error: "forbidden" }, 403);
    }
  }

  // Claimed exactly like a 1:1 message, so the sender's invoke and the
  // database trigger racing each other produce one fan-out and not two.
  const { data: claim } = await admin
    .from("room_message_pushes")
    .upsert({ message_id: msg.id }, { onConflict: "message_id", ignoreDuplicates: true })
    .select("message_id");
  if (!claim || claim.length === 0) return json({ skipped: "already-pushed" }, 200);

  const releaseClaim = async () => {
    await admin.from("room_message_pushes").delete().eq("message_id", msg.id);
  };

  const { data: participants } = await admin
    .from("room_participants")
    .select("user_id")
    .eq("room_id", msg.room_id);

  const receivers = (participants ?? [])
    .map((p) => p.user_id as string)
    .filter((id) => id !== msg.sender_id);
  if (receivers.length === 0) {
    await releaseClaim();
    return json({ sent: 0, reason: "no other members" }, 200);
  }

  const [{ data: room }, { data: sender }] = await Promise.all([
    admin.from("rooms").select("title").eq("id", msg.room_id).maybeSingle(),
    admin.from("profiles").select("display_name").eq("id", msg.sender_id).maybeSingle(),
  ]);

  const roomTitle = (room?.title as string | undefined)?.trim() || "a room";
  const name = sender?.display_name ? `@${sender.display_name}` : "someone";

  // The ladder is per receiver per ROOM, so a group of six talking at once
  // rings a phone on the first few messages rather than on all six, and a
  // member who has read the room hears its next message at full volume.
  const [{ data: anchors }, { data: reads }] = await Promise.all([
    admin
      .from("room_push_alerts")
      .select("receiver_id, alerted_at, streak")
      .eq("room_id", msg.room_id)
      .in("receiver_id", receivers),
    admin
      .from("room_receipts")
      .select("user_id, read_at")
      .eq("room_id", msg.room_id)
      .in("user_id", receivers),
  ]);

  const anchorFor = new Map<string, AlertAnchor | null>();
  for (const row of anchors ?? []) {
    anchorFor.set(
      row.receiver_id as string,
      anchorFrom(row.alerted_at as string, row.streak as number),
    );
  }
  const readFor = new Map<string, number>();
  for (const row of reads ?? []) {
    readFor.set(row.user_id as string, Date.parse(row.read_at as string));
  }

  const now = Date.now();
  const due: string[] = [];
  const quiet: string[] = [];
  // Whose anchor moves, and to what. Only the people the ladder actually rang:
  // a receiver who is only in `due` because there is no quiet channel to fall
  // back to has not spent a rung, and stamping them would slide their window.
  const rung = new Map<string, number>();
  for (const id of receivers) {
    const decision = decideAlert(anchorFor.get(id) ?? null, now, readFor.get(id) ?? NaN);
    if (decision.alerting) rung.set(id, decision.streak);
    // Without a quiet channel configured there is nowhere silent to post, so
    // everything rings — the behaviour this function had before the cooldown.
    if (decision.alerting || !ANDROID_QUIET_CHANNEL_ID) due.push(id);
    else quiet.push(id);
  }

  const post = async (aliases: string[], silent: boolean) => {
    if (aliases.length === 0) return true;
    const response = await fetch("https://api.onesignal.com/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        target_channel: "push",
        include_aliases: { external_id: aliases },
        headings: { en: roomTitle },
        contents: { en: bodyFor(name, msg.media_type as string | null) },
        android_channel_id: silent ? ANDROID_QUIET_CHANNEL_ID : ANDROID_CHANNEL_ID,
        ios_interruption_level: silent ? "passive" : "active",
        priority: 10,
        // Stacked per room, so a group reads as one entry in the shade.
        android_group: `room:${msg.room_id}`,
        data: { roomId: msg.room_id, senderId: msg.sender_id },
      }),
    });
    const result = (await response.json().catch(() => ({}))) as { id?: string };
    return response.ok && !!result.id;
  };

  const [dueOk, quietOk] = await Promise.all([post(due, false), post(quiet, true)]);

  if (!dueOk && !quietOk) {
    // Nobody has a device registered yet, or OneSignal refused. A stuck claim
    // would silence the retry forever.
    await releaseClaim();
    return json({ sent: 0 }, 200);
  }

  // Moved only for the people who were actually rung, and only once the
  // notification is out — stamped before the send, a delivery that failed
  // would still close the window and the retry would arrive silent.
  if (dueOk && rung.size > 0) {
    await admin.from("room_push_alerts").upsert(
      [...rung].map(([receiver_id, streak]) => ({
        receiver_id,
        room_id: msg.room_id,
        alerted_at: new Date(now).toISOString(),
        streak,
      })),
      { onConflict: "receiver_id,room_id" },
    );
  }

  return json({ sent: due.length + quiet.length, quiet: quiet.length }, 200);
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
    const { message_id, room_message_id } = (await req.json()) as {
      message_id?: string;
      room_message_id?: string;
    };
    if (room_message_id) return await pushRoomMessage(admin, req, room_message_id);
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
    // finishes a sentence — but a single sound for the whole burst is a phone
    // in a pocket reporting six messages once and then going quiet for the rest
    // of the conversation. The ladder rings the first message, two more while
    // the burst is still happening, and then one every forty seconds; the ones
    // in between still appear in the shade and still raise the count.
    //
    // The anchor is the last notification that *rang*, not the last one sent —
    // see `0035_push_alerts` for why the difference matters — and it is read
    // alongside the receiver's own read watermark, which is what tells a new
    // turn in the conversation apart from the tail of a burst.
    const [{ data: anchorRow }, { data: receipt }] = await Promise.all([
      admin
        .from("push_alerts")
        .select("alerted_at, streak")
        .eq("receiver_id", msg.receiver_id)
        .eq("sender_id", msg.user_id)
        .maybeSingle(),
      admin
        .from("message_receipts")
        .select("read_at")
        .eq("user_id", msg.receiver_id)
        .eq("peer_id", msg.user_id)
        .maybeSingle(),
    ]);

    const now = Date.now();
    const readAt = receipt?.read_at ? Date.parse(receipt.read_at) : NaN;
    const decision = decideAlert(
      anchorFrom(anchorRow?.alerted_at, anchorRow?.streak),
      now,
      readAt,
    );
    // Without a quiet channel configured there is nowhere silent to post, and
    // a notification nobody hears about is worse than one heard twice.
    const quiet = !decision.alerting && !!ANDROID_QUIET_CHANNEL_ID;

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

    // Moved only once the notification is actually out, and only when the
    // ladder said to ring — a notification that is loud only because no quiet
    // channel is configured has not spent a rung. Stamped before the send, a
    // delivery that failed would still close the window and the retry would
    // arrive silent.
    if (decision.alerting) {
      await admin
        .from("push_alerts")
        .upsert(
          {
            receiver_id: msg.receiver_id,
            sender_id: msg.user_id,
            alerted_at: new Date(now).toISOString(),
            streak: decision.streak,
          },
          { onConflict: "receiver_id,sender_id" },
        );
    }

    return json({ sent: 1, notification_id: result.id, quiet }, 200);
  } catch (error) {
    return json({ error: String(error) }, 500);
  }
});
