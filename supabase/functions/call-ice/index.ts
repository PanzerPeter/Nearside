// call-ice — short-lived TURN credentials for a call, inside a hard budget.
//
// STUN alone connects most calls directly. It does not when either phone is
// behind symmetric NAT or carrier-grade NAT, which on mobile networks is
// ordinary rather than exotic, and those calls need a relay or they do not
// happen at all.
//
// The relay sees nothing it should not. SRTP keys come out of the DTLS
// handshake between the two devices, so a TURN server forwards packets it
// cannot decrypt — it learns that two addresses exchanged traffic and nothing
// about what was said. That is why using one costs the app's claims nothing,
// and why the credentials it hands out are minted per session with a short life
// rather than baked into the APK: a long-lived TURN secret shipped inside an
// app is a free relay for whoever unzips it.
//
// **The budget, and why it is enforced here.** Cloudflare Realtime gives 1,000
// GB of egress a month and then bills $0.05/GB. It offers no spending cap, so
// left alone the only thing between this app and an invoice is nobody using it.
// Before minting anything this function asks Cloudflare how much of the month's
// egress the TURN key has already spent, and refuses once the configured budget
// is gone. Refusing is not an outage: the client falls back to STUN and most
// calls still connect.
//
// It refuses whenever it *cannot* tell, too — an unset account id, an analytics
// token without the permission, a GraphQL error. A guard that fails open is not
// a guarantee, and the whole point of this is to be one.
//
// Required Edge Function secrets (Dashboard → Edge Functions → Secrets):
//   CLOUDFLARE_TURN_KEY_ID    — the TURN key id from Cloudflare Realtime
//   CLOUDFLARE_TURN_API_TOKEN — its API token; server-side only
//   CLOUDFLARE_ACCOUNT_ID     — the account the TURN key belongs to
// Optional:
//   CLOUDFLARE_ANALYTICS_API_TOKEN — a token with the "Account Analytics"
//       permission. Falls back to the TURN token, which only works if that
//       token carries the permission as well.
//   TURN_MONTHLY_BUDGET_GB    — default 900, deliberately under the free 1,000.
//
// With no TURN secrets at all this answers 200 with no servers rather than an
// error, and `lib/call/ice.ts` falls back to STUN alone. A deployment with no
// TURN configured should still place the calls it can, not refuse all of them.
//
// Deploy normally (JWT verification on): every caller is a signed-in user.
//   supabase functions deploy call-ice

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const TURN_KEY_ID = Deno.env.get("CLOUDFLARE_TURN_KEY_ID")?.trim();
const TURN_API_TOKEN = Deno.env.get("CLOUDFLARE_TURN_API_TOKEN")?.trim();
const ACCOUNT_ID = Deno.env.get("CLOUDFLARE_ACCOUNT_ID")?.trim();
const ANALYTICS_TOKEN =
  Deno.env.get("CLOUDFLARE_ANALYTICS_API_TOKEN")?.trim() || TURN_API_TOKEN;

/**
 * How long the credentials last.
 *
 * Long enough for a call that starts now to finish — an ICE restart mid-call
 * re-uses the same credentials — and short enough that a set copied off a
 * device is worthless within the hour.
 */
const TTL_SECONDS = 3600;

/**
 * The ceiling, in bytes.
 *
 * Under the free 1,000 GB on purpose. Cloudflare's own documentation says the
 * analytics dataset is not what it bills from, so the number read here is an
 * estimate and the gap is the margin for it being wrong in the expensive
 * direction.
 */
const parsedBudget = Number(Deno.env.get("TURN_MONTHLY_BUDGET_GB") ?? "");
const BUDGET_GB = Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : 900;
const BUDGET_BYTES = BUDGET_GB * 1_000_000_000;

/**
 * How long a usage reading is trusted.
 *
 * Cloudflare says TURN usage appears in analytics within 30 seconds, so the
 * worst case this cache allows is five minutes of relayed traffic past the
 * budget. At the relay rate of a handful of concurrent video calls that is
 * megabytes, against a margin of 100 GB.
 */
const USAGE_CACHE_MS = 5 * 60 * 1000;

let usageCache: { bytes: number; readAt: number } | null = null;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** First of the current UTC month, and today, as the GraphQL `Date` scalar. */
function monthToDate(now: Date): { from: string; to: string } {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return { from: `${year}-${month}-01`, to: now.toISOString().slice(0, 10) };
}

const USAGE_QUERY = `
query TurnUsage($accountId: String!, $keyId: String!, $from: Date!, $to: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountId }) {
      callsTurnUsageAdaptiveGroups(
        limit: 10000
        filter: { keyId: $keyId, date_geq: $from, date_leq: $to }
      ) {
        sum { egressBytes }
      }
    }
  }
}`;

/**
 * Egress this key has spent this month, or null if it could not be established.
 *
 * Egress only, because that is what Cloudflare bills: bytes sent from its edge
 * to a TURN client. Ingress is free and counting it would close the tap at
 * roughly half the real budget.
 *
 * Null is not zero. Every path that cannot produce a number returns it, and the
 * caller treats it as "over budget" — a missing account id, a token without the
 * Account Analytics permission, a GraphQL error, an account filter that matched
 * nothing. Reading a failure as zero usage is how a guard like this quietly
 * stops guarding.
 */
async function egressThisMonth(now: Date): Promise<number | null> {
  if (!ACCOUNT_ID || !ANALYTICS_TOKEN || !TURN_KEY_ID) return null;

  const cached = usageCache;
  if (cached && now.getTime() - cached.readAt < USAGE_CACHE_MS) return cached.bytes;

  const { from, to } = monthToDate(now);
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ANALYTICS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: USAGE_QUERY,
      variables: { accountId: ACCOUNT_ID, keyId: TURN_KEY_ID, from, to },
    }),
  });
  if (!response.ok) return null;

  const body = (await response.json().catch(() => null)) as {
    errors?: unknown[];
    data?: {
      viewer?: {
        accounts?: { callsTurnUsageAdaptiveGroups?: { sum?: { egressBytes?: number } }[] }[];
      };
    };
  } | null;
  if (!body || (Array.isArray(body.errors) && body.errors.length > 0)) return null;

  const accounts = body.data?.viewer?.accounts;
  // An account filter that matched nothing means the id is wrong, not that the
  // account used nothing. An empty group list under a real account does mean
  // zero, and is the ordinary answer on the first day of a month.
  if (!Array.isArray(accounts) || accounts.length === 0) return null;

  let bytes = 0;
  for (const account of accounts) {
    for (const group of account.callsTurnUsageAdaptiveGroups ?? []) {
      const egress = group.sum?.egressBytes;
      if (typeof egress === "number" && Number.isFinite(egress)) bytes += egress;
    }
  }

  usageCache = { bytes, readAt: now.getTime() };
  return bytes;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Signed in, or nothing. Relay bandwidth is metered and an unauthenticated
  // mint endpoint is an open proxy with someone else's name on the invoice.
  const { createClient } = await import("npm:@supabase/supabase-js@2");
  const asUser = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const { data: userData } = await asUser.auth.getUser();
  if (!userData?.user) return json({ error: "forbidden" }, 403);

  if (!TURN_KEY_ID || !TURN_API_TOKEN) {
    // Not an error: the client falls back to STUN and most calls still connect.
    return json({ iceServers: [], ttl: 0, reason: "turn-not-configured" }, 200);
  }

  try {
    const spent = await egressThisMonth(new Date()).catch(() => null);
    if (spent === null) {
      return json({ iceServers: [], ttl: 0, reason: "turn-budget-unknown" }, 200);
    }
    if (spent >= BUDGET_BYTES) {
      return json(
        { iceServers: [], ttl: 0, reason: "turn-budget-spent", spentGb: spent / 1e9, budgetGb: BUDGET_GB },
        200
      );
    }

    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TURN_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      }
    );

    if (!response.ok) return json({ iceServers: [], ttl: 0, reason: response.status }, 200);

    // Passed straight through. Cloudflare answers with an `iceServers` array
    // whose one entry bundles the STUN url with the three TURN transports under
    // a single username and credential, but `normalizeIceServers` on the client
    // accepts a bare object too — one place to fix if a provider changes shape.
    const result = (await response.json()) as { iceServers?: unknown };
    return json({ iceServers: result.iceServers ?? [], ttl: TTL_SECONDS }, 200);
  } catch (error) {
    return json({ iceServers: [], ttl: 0, reason: String(error) }, 200);
  }
});
