// send-push — deliver a Web Push notification to a message's receiver.
//
// Two callers, either of which is sufficient on its own:
//
//   1. The *sender's* browser, fire-and-forget right after the insert:
//      supabase.functions.invoke('send-push', { body: { message_id } }).
//      Authenticated as the sender; we confirm they authored the message.
//   2. The database, from the AFTER INSERT trigger in migration 0014, over
//      pg_net with a shared secret in `x-push-secret`. This path survives the
//      sender's browser being closed, offline, or on a route that can reach
//      Postgres but not the Functions host — the cases where the old
//      browser-only trigger silently dropped the notification entirely.
//
// Delivery is de-duplicated by claiming a row in `message_pushes`, so both
// callers racing produces exactly one notification, not two.
//
// Required Edge Function secrets (Dashboard → Edge Functions → Secrets):
//   VAPID_PUBLIC_KEY   — same key the client uses (VITE_VAPID_PUBLIC_KEY)
//   VAPID_PRIVATE_KEY  — the private half of the VAPID pair
//   VAPID_SUBJECT      — e.g. mailto:you@example.com
//   PUSH_TRIGGER_SECRET — only for caller (2); must equal
//                         public.push_config.trigger_secret
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected
// automatically by the Edge runtime.
//
// NOTE: caller (2) has no user JWT, so enabling it means deploying with
//   supabase functions deploy send-push --no-verify-jwt
// Authorisation then rests on the checks in this file: a request is either a
// valid user who authored the message, or a valid trigger secret. Anything
// else is rejected. If you are not using the database trigger, leave
// verify_jwt on and PUSH_TRIGGER_SECRET unset.

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
// Trim to survive the classic "pasted a trailing newline/space into the secret
// field" case, which otherwise changes the decoded byte length and makes
// setVapidDetails reject an otherwise-correct key.
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")?.trim();
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")?.trim();
// Unset ⇒ the database-trigger path is disabled entirely.
const TRIGGER_SECRET = Deno.env.get("PUSH_TRIGGER_SECRET")?.trim();

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

// web-push requires the subject to be a plain `mailto:` or `https:` URL. Users
// sometimes paste it in other shapes (a Markdown link `[url](url)`, a bare
// email, brackets/quotes). Normalize to a valid form, falling back to a safe
// default — the subject is only contact metadata for push services, so a
// fallback keeps notifications working instead of crashing the whole function.
const DEFAULT_SUBJECT = "mailto:admin@chatly.app";
function normalizeSubject(raw: string | undefined): string {
  let s = (raw ?? "").trim();
  if (!s) return DEFAULT_SUBJECT;
  // Unwrap a Markdown link: [text](https://…) -> https://…
  const md = s.match(/\]\((https?:[^)\s]+|mailto:[^)\s]+)\)/);
  if (md) s = md[1];
  // Strip stray wrapping punctuation.
  s = s.replace(/^[[<'"`\s]+/, "").replace(/[\]>'"`\s]+$/, "").trim();
  if (s.startsWith("mailto:") || s.startsWith("https:")) return s;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return `mailto:${s}`;
  return DEFAULT_SUBJECT;
}
const VAPID_SUBJECT = normalizeSubject(Deno.env.get("VAPID_SUBJECT"));

// Configure web-push lazily and exactly once. Doing this at module top level
// meant a missing/invalid key threw during boot and crashed the ENTIRE worker —
// including the CORS preflight (OPTIONS), so browsers never sent the POST and no
// push was ever delivered. Now a config problem yields a clean 500 with a
// diagnosable message and the preflight keeps working.
let vapidReady = false;
let vapidError: string | null = null;
function ensureVapidConfigured(): boolean {
  if (vapidReady) return true;
  if (vapidError) return false;
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    vapidError =
      "VAPID keys are not configured — set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY " +
      "in the send-push Edge Function secrets.";
    console.error(vapidError);
    return false;
  }
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    vapidReady = true;
    return true;
  } catch (e) {
    vapidError = `Invalid VAPID configuration: ${String((e as Error)?.message ?? e)}`;
    console.error(vapidError);
    return false;
  }
}

// Decoded byte length of a base64url key, for diagnostics only (public must be
// 65, private 32). Never logs the key itself — only its length.
function decodedLen(key: string | undefined): number | null {
  if (!key) return null;
  try {
    const b64 = key.replace(/-/g, "+").replace(/_/g, "/");
    return atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")).length;
  } catch {
    return -1;
  }
}

// Boot self-test — runs the real validation once and logs WHY it fails, using
// only safe shape info (presence, decoded byte lengths, subject scheme). No
// secret values are ever logged. Visible in the function's Logs tab.
console.log("send-push boot — VAPID self-test:", {
  publicKeyPresent: !!VAPID_PUBLIC,
  privateKeyPresent: !!VAPID_PRIVATE,
  publicKeyBytes: decodedLen(VAPID_PUBLIC),
  privateKeyBytes: decodedLen(VAPID_PRIVATE),
  subjectScheme: VAPID_SUBJECT.split(":")[0],
  configured: ensureVapidConfigured(),
  error: vapidError,
});

function preview(content: string | null, mediaType: string | null): string {
  const text = content?.trim();
  if (text) return text.length > 120 ? text.slice(0, 117) + "…" : text;
  if (mediaType === "image") return "📷 Photo";
  if (mediaType === "video") return "🎥 Video";
  if (mediaType === "audio") return "🎤 Voice message";
  return "New message";
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // Trusted caller: the database trigger, which has no user to authenticate
    // as. Checked first so a request carrying a valid secret never needs a JWT.
    const fromTrigger = secretMatches(req.headers.get("x-push-secret"));

    let userId: string | null = null;
    if (!fromTrigger) {
      const authHeader = req.headers.get("Authorization") ?? "";
      const userClient = createClient(SUPABASE_URL, ANON, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user } } = await userClient.auth.getUser();
      if (!user) return json({ error: "unauthorized" }, 401);
      userId = user.id;
    }

    if (!ensureVapidConfigured()) return json({ error: vapidError }, 500);

    const { message_id } = await req.json().catch(() => ({}));
    if (!message_id) return json({ error: "message_id required" }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: msg } = await admin
      .from("messages")
      .select("id, user_id, receiver_id, content, media_type, deleted_at")
      .eq("id", message_id)
      .maybeSingle();

    if (!msg) return json({ error: "not found" }, 404);
    // A user may only trigger a push for a message they actually authored.
    // The trigger path is exempt: it is the database itself, and the row it
    // names is one it just wrote.
    if (!fromTrigger && msg.user_id !== userId) return json({ error: "not found" }, 404);
    if (msg.deleted_at) return json({ skipped: "deleted" }, 200);
    // A note to yourself: the sender and the receiver are the same person, so
    // "notifying the receiver" means telling someone what they just typed.
    // The database trigger skips these too (0017); this is the guard on the
    // path both callers share, and it must not claim the message either.
    if (msg.user_id === msg.receiver_id) return json({ skipped: "self-chat" }, 200);

    // Claim the message. The primary key makes this the single point where
    // "has this been pushed?" is decided, so the browser and the database
    // trigger racing each other yields one notification rather than two —
    // and a retry of either can never re-notify. `ignoreDuplicates` turns the
    // conflict into a no-op returning zero rows rather than an error.
    const { data: claim } = await admin
      .from("message_pushes")
      .upsert({ message_id: msg.id }, { onConflict: "message_id", ignoreDuplicates: true })
      .select("message_id");
    if (!claim || claim.length === 0) return json({ skipped: "already-pushed" }, 200);

    const { data: sender } = await admin
      .from("profiles")
      .select("username")
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

    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("user_id", msg.receiver_id);

    /** Give the claim back, so a later retry (or the other caller) can still
     *  deliver. A claim only sticks when it actually produced a notification. */
    const releaseClaim = async () => {
      await admin.from("message_pushes").delete().eq("message_id", msg.id);
    };

    if (!subs || subs.length === 0) {
      // No device registered *yet* — the receiver may enable notifications a
      // moment from now, and a stuck claim would silence the retry forever.
      await releaseClaim();
      return json({ sent: 0 }, 200);
    }

    const payload = JSON.stringify({
      title: nick?.nickname?.trim() ||
        (sender?.username ? `@${sender.username}` : "New message"),
      body: preview(msg.content, msg.media_type),
      tag: `dm:${msg.user_id}`,
      data: { url: "/", senderId: msg.user_id },
    });

    const dead: string[] = [];
    let delivered = 0;
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
          );
          delivered++;
        } catch (err) {
          // 404/410 => subscription is gone; prune it.
          const code = (err as { statusCode?: number })?.statusCode;
          if (code === 404 || code === 410) dead.push(s.id);
        }
      }),
    );

    if (dead.length) await admin.from("push_subscriptions").delete().in("id", dead);

    // Nothing got through and nothing was permanently gone ⇒ the push service
    // was unreachable or rate-limiting. Release the claim so the other caller
    // still has a chance rather than the notification being lost for good.
    const transientFailure = delivered === 0 && dead.length < subs.length;
    if (transientFailure) await releaseClaim();

    return json({ sent: delivered, pruned: dead.length, retryable: transientFailure }, 200);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
