// report-user — file a report about a contact, as an email ticket.
//
// The server cannot read a conversation, so a report about what somebody said
// is only worth something if the person reporting chooses to show it. This is
// that choice, made explicit in the app: the reporter's device sends its own
// decrypted copy of up to the last 30 messages, and this function mails them,
// with the complaint, to the moderation inbox. Nothing is sent unless the
// reporter ticks the box, and nothing of it is written to the database —
// `reports` holds who reported whom and when, and no text at all.
//
// What the server can vouch for, and what it cannot. Each quoted message is
// matched by id against `messages`: that it exists, that it belongs to this
// conversation, who sent it and when all come from the row, not from the
// request. The text cannot be checked — the server never held a key to it —
// and the email says so. A reporter can misquote; they cannot invent a message
// the other person never sent, or change who sent one.
//
// Required Edge Function secrets:
//   RESEND_API_KEY    — https://resend.com API key; server-side only
// Optional:
//   REPORT_EMAIL_TO   — the inbox reports go to (default hi.nearside@gmail.com)
//   REPORT_EMAIL_FROM — a sender on a domain verified with Resend. The default,
//                       onboarding@resend.dev, only delivers to the address
//                       the Resend account itself was registered with.
//
// Deploy normally (JWT verification on): the only caller is a signed-in user.
//   supabase functions deploy report-user

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")?.trim();
const REPORT_EMAIL_TO = Deno.env.get("REPORT_EMAIL_TO")?.trim() || "hi.nearside@gmail.com";
const REPORT_EMAIL_FROM =
  Deno.env.get("REPORT_EMAIL_FROM")?.trim() || "Nearside Reports <onboarding@resend.dev>";

/** Mirrors REPORT_MESSAGE_LIMIT in src/lib/report.ts. */
const MESSAGE_LIMIT = 30;
const REASON_MAX = 2000;
const TEXT_MAX = 4000;
/** Per reporter, per rolling day. A person reporting by hand files one or two;
 *  this stops a script turning the function into a mail cannon. */
const DAILY_LIMIT = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface QuotedMessage {
  id: string;
  text: string | null;
}

interface MessageRow {
  id: string;
  user_id: string;
  receiver_id: string;
  media_type: string | null;
  deleted_at: string | null;
  created_at: string;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** `YYYY-MM-DD HH:MM UTC` — one clock for everyone reading the ticket. */
function stamp(iso: string): string {
  return iso.slice(0, 16).replace("T", " ") + " UTC";
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!RESEND_API_KEY) return json({ error: "email-not-configured" }, 500);

  try {
    const body = (await req.json()) as {
      reported_id?: unknown;
      reason?: unknown;
      messages?: unknown;
    };
    const reportedId = typeof body.reported_id === "string" ? body.reported_id : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!UUID.test(reportedId)) return json({ error: "reported_id must be a uuid" }, 400);
    if (!reason) return json({ error: "reason required" }, 400);

    const quoted: QuotedMessage[] = (Array.isArray(body.messages) ? body.messages : [])
      .filter(
        (m): m is QuotedMessage =>
          !!m && typeof m === "object" && typeof (m as QuotedMessage).id === "string" &&
          UUID.test((m as QuotedMessage).id)
      )
      .slice(0, MESSAGE_LIMIT)
      .map((m) => ({ id: m.id, text: typeof m.text === "string" ? m.text : null }));

    const asUser = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
      auth: { persistSession: false },
    });
    const { data: userData } = await asUser.auth.getUser();
    const reporter = userData?.user?.id;
    if (!reporter) return json({ error: "unauthorized" }, 401);
    if (reporter === reportedId) return json({ error: "cannot report yourself" }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // Only someone you are connected to, or have a block with. There is no
    // directory, so any other id is one the reporter should not have — and
    // without this the function would mail a ticket about anyone.
    const pair =
      `and(requester_id.eq.${reporter},addressee_id.eq.${reportedId}),` +
      `and(requester_id.eq.${reportedId},addressee_id.eq.${reporter})`;
    const { data: friendship } = await admin
      .from("friendships")
      .select("id")
      .or(pair)
      .limit(1)
      .maybeSingle();
    const { data: block } = await admin
      .from("blocks")
      .select("blocker_id")
      .or(
        `and(blocker_id.eq.${reporter},blocked_id.eq.${reportedId}),` +
          `and(blocker_id.eq.${reportedId},blocked_id.eq.${reporter})`
      )
      .limit(1)
      .maybeSingle();
    if (!friendship && !block) return json({ error: "not-a-contact" }, 403);

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await admin
      .from("reports")
      .select("id", { count: "exact", head: true })
      .eq("reporter_id", reporter)
      .gte("created_at", since);
    if ((count ?? 0) >= DAILY_LIMIT) return json({ error: "rate-limited" }, 429);

    // Who sent each quoted message, and when, from the row — never from the
    // request. Anything that is not part of this conversation is dropped.
    const rows = new Map<string, MessageRow>();
    if (quoted.length > 0) {
      const { data, error } = await admin
        .from("messages")
        .select("id, user_id, receiver_id, media_type, deleted_at, created_at")
        .in("id", quoted.map((m) => m.id));
      if (error) throw new Error(`reading messages: ${error.message}`);
      for (const row of (data ?? []) as MessageRow[]) {
        const inPair =
          (row.user_id === reporter && row.receiver_id === reportedId) ||
          (row.user_id === reportedId && row.receiver_id === reporter);
        if (inPair) rows.set(row.id, row);
      }
    }
    const matched = quoted
      .filter((m) => rows.has(m.id))
      .sort((a, b) => rows.get(a.id)!.created_at.localeCompare(rows.get(b.id)!.created_at));
    const dropped = quoted.length - matched.length;

    const { data: profiles } = await admin
      .from("profiles")
      .select("id, display_name")
      .in("id", [reporter, reportedId]);
    const nameOf = (id: string) =>
      `@${profiles?.find((p) => p.id === id)?.display_name ?? "unknown"}`;

    const { data: ticket, error: ticketError } = await admin
      .from("reports")
      .insert({ reporter_id: reporter, reported_id: reportedId })
      .select("id, created_at")
      .single();
    if (ticketError || !ticket) throw new Error(`recording report: ${ticketError?.message}`);
    const ticketNo = String(ticket.id).slice(0, 8).toUpperCase();

    const lines = matched.map((m) => {
      const row = rows.get(m.id)!;
      const who = row.user_id === reporter ? "reporter" : "reported";
      const what = row.deleted_at
        ? "[deleted by its sender]"
        : m.text?.trim()
          ? clip(m.text.trim(), TEXT_MAX)
          : row.media_type
            ? `[${row.media_type}]`
            : "[no text]";
      return `[${stamp(row.created_at)}] ${nameOf(row.user_id)} (${who}): ${what}`;
    });

    const text = [
      `Nearside report #${ticketNo}`,
      `Filed: ${stamp(ticket.created_at)}`,
      "",
      `Reported: ${nameOf(reportedId)}  (${reportedId})`,
      `Reporter: ${nameOf(reporter)}  (${reporter})`,
      `Blocked:  ${block ? "yes" : "no"}`,
      "",
      "Complaint",
      "---------",
      clip(reason, REASON_MAX),
      "",
      matched.length > 0
        ? `Last ${matched.length} message(s), as the reporter's device decrypted them`
        : "No messages were shared with this report.",
      ...(matched.length > 0
        ? [
            "---------",
            ...lines,
            "",
            "Each message above was matched against the server by id: that it exists,",
            "that it is from this conversation, who sent it and when are confirmed.",
            "The text is not — the server never holds a key to it.",
          ]
        : []),
      ...(dropped > 0
        ? ["", `${dropped} quoted message(s) did not match this conversation and were left out.`]
        : []),
    ].join("\n");

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: REPORT_EMAIL_FROM,
        to: [REPORT_EMAIL_TO],
        subject: `[Nearside report #${ticketNo}] ${nameOf(reportedId)}`,
        text,
      }),
    });
    if (!response.ok) {
      // A ticket nobody received is not a ticket. Take the row back so the
      // reporter's retry is not counted twice against their limit.
      await admin.from("reports").delete().eq("id", ticket.id);
      const detail = await response.text().catch(() => "");
      console.error("report email failed", response.status, detail);
      return json({ error: "email-failed" }, 502);
    }

    return json({ ok: true, ticket: ticketNo }, 200);
  } catch (error) {
    console.error("report-user", error);
    return json({ error: String((error as Error)?.message ?? error) }, 500);
  }
});
