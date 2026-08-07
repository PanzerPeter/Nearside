// delete-account — permanently destroy the *calling* user's account.
//
// Invoked from Settings → Danger zone: supabase.functions.invoke('delete-account').
// There is no body and none is read: the account to delete is resolved solely
// from the caller's JWT via an anon-key client, so a request can never name a
// victim. Everything after that runs on the service role and bypasses RLS.
//
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected
// automatically by the Edge runtime; this function needs no secrets of its own.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANON = Deno.env.get("SUPABASE_ANON_KEY");

// Resolve config lazily rather than with `!` at module top level: a missing
// variable there throws during boot and takes the whole worker down, including
// the CORS preflight, so the browser reports an opaque network error instead of
// a diagnosable one. Same reasoning as send-push.
//
// Returning the resolved config (rather than a boolean) lets callers use it
// directly instead of re-reading the module-level `string | undefined`
// constants and casting them — TS narrowing doesn't survive a separate
// `ensureConfigured()` call, only a value actually returned from one.
interface Config {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}

let config: Config | null = null;
let configError: string | null = null;
function ensureConfigured(): Config | null {
  if (config) return config;
  if (SUPABASE_URL && SERVICE_ROLE && ANON) {
    config = { url: SUPABASE_URL, anonKey: ANON, serviceRoleKey: SERVICE_ROLE };
    return config;
  }
  configError =
    "Edge runtime environment is incomplete — SUPABASE_URL, SUPABASE_ANON_KEY " +
    "and SUPABASE_SERVICE_ROLE_KEY must all be present.";
  console.error(configError);
  return null;
}

const AVATARS_BUCKET = "avatars";
const MEDIA_BUCKET = "chat-media";
// Personal scale (<50 accounts, <20 friends each), so one page is the whole
// listing; a larger page would still be a single round trip either way.
const LIST_LIMIT = 1000;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type StorageClient = ReturnType<typeof createClient>["storage"];

/**
 * Whether a `chat-media` top-level folder belongs to a conversation this user
 * is in. The key is `${sortedA}_${sortedB}` (see src/lib/conversation.ts), so
 * the test is *whole-segment equality* after splitting on `_` — never
 * `folder.includes(uid)`. A substring test would widen the match to anything
 * that merely embeds the id, and this deletes the other participant's media
 * too; there is no undo. The two-segment shape is required as well, so a
 * malformed or hand-made folder name can never be swept in by accident.
 * Mirrors the split_part() participant check in storage-setup.sql.
 *
 * This file is Deno and outside tsconfig/eslint/vitest, so nothing here is
 * type-checked, linted or tested by the gate. The logic is mirrored — and
 * actually tested — as `isConversationFolder` in src/lib/conversation.ts.
 * Keep this copy behaviourally identical to that one; they cannot import
 * from each other across the runtime boundary, so a change to either must be
 * applied to both by hand.
 */
function isConversationFolder(folder: string, uid: string): boolean {
  const parts = folder.split("_");
  return parts.length === 2 && (parts[0] === uid || parts[1] === uid);
}

async function listNames(storage: StorageClient, bucket: string, prefix: string) {
  const { data, error } = await storage.from(bucket).list(prefix, { limit: LIST_LIMIT });
  if (error) throw new Error(`listing ${bucket}/${prefix}: ${error.message}`);
  const entries = data ?? [];
  // A full page means there may be more we never asked for — at this scale
  // that means a listing (and therefore the delete) silently missed objects,
  // which is the one failure mode this function can't detect for itself.
  if (entries.length === LIST_LIMIT) {
    console.warn(`listing ${bucket}/${prefix} returned ${LIST_LIMIT} entries — possible truncation`);
  }
  return entries;
}

/** Every object path under `avatars/{uid}/`. */
async function avatarPaths(storage: StorageClient, uid: string): Promise<string[]> {
  const entries = await listNames(storage, AVATARS_BUCKET, uid);
  return entries.map((e) => `${uid}/${e.name}`);
}

/** Every object path in a `chat-media` conversation folder involving `uid`. */
async function mediaPaths(storage: StorageClient, uid: string): Promise<string[]> {
  const top = await listNames(storage, MEDIA_BUCKET, "");
  // `list('')` returns folders as synthetic entries with a null id; real
  // objects at the bucket root (there should be none) have one.
  const folders = top.filter((e) => e.id === null && isConversationFolder(e.name, uid));
  const paths: string[] = [];
  for (const folder of folders) {
    const entries = await listNames(storage, MEDIA_BUCKET, folder.name);
    for (const entry of entries) paths.push(`${folder.name}/${entry.name}`);
  }
  return paths;
}

async function removeAll(storage: StorageClient, bucket: string, paths: string[]) {
  if (paths.length === 0) return;
  const { error } = await storage.from(bucket).remove(paths);
  if (error) throw new Error(`removing from ${bucket}: ${error.message}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // The action is irreversible, so it is worth refusing to run it from a shape
  // that was never meant to trigger it.
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  try {
    const config = ensureConfigured();
    if (!config) return json({ error: configError }, 500);

    // The *only* source of the identity being deleted. Nothing from the body,
    // query string or any other header is read, so there is no input that can
    // point this at a different account.
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(config.url, config.anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    const uid = user.id;

    const admin = createClient(config.url, config.serviceRoleKey);

    // Storage first, deliberately: the object paths are derived from the uid
    // and from conversation keys built out of friendships, and both are gone
    // the moment the auth user is deleted (profiles.id cascades). Delete the
    // files while they can still be found; a failure here leaves the account
    // fully intact and the call can simply be retried.
    await removeAll(admin.storage, AVATARS_BUCKET, await avatarPaths(admin.storage, uid));
    await removeAll(admin.storage, MEDIA_BUCKET, await mediaPaths(admin.storage, uid));

    // There is no table to clear by hand before this. The invite_codes cleanup
    // that used to sit here outlived its table — 0019 opened signup and dropped
    // it — so PostgREST answered every deletion with "table not found" and this
    // function returned 500 *after* the storage wipe above had already run:
    // the account survived, its photos did not. Everything that remains hangs
    // off auth.users with an ON DELETE action, so the one call below is the
    // whole deletion. Anything added later with a bare reference (no ON DELETE)
    // has to be cleared here, and this is the reminder to check.
    //
    // Cascades from profiles.id take messages, friendships, reactions,
    // receipts, nicknames, rooms and connect tokens with it.
    const { error: deleteError } = await admin.auth.admin.deleteUser(uid);
    if (deleteError) return json({ error: `deleting user: ${deleteError.message}` }, 500);

    return json({ ok: true }, 200);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
