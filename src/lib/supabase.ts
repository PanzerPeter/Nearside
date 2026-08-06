import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase environment variables. Copy .env.example to .env and set ' +
      'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'
  );
}

/** Cap on a read. Without one a request over a stalled tunnel hangs forever —
 *  the connection is neither open enough to answer nor closed enough to fail,
 *  which is exactly what a congested VPN looks like. */
const READ_TIMEOUT_MS = 25_000;
/** Extra attempts for reads only. */
const READ_RETRIES = 2;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `fetch` with a timeout and retries for reads.
 *
 * Reads only, deliberately: a retried POST would double-insert a message, and
 * a timeout on an upload would kill a legitimately slow 50 MB video. Reads are
 * idempotent, so retrying one is free — and on a lossy link (mobile roaming, a
 * VPN hop, a censored route) a single dropped GET is otherwise a blank
 * conversation list or a chat that silently fails to load.
 */
const resilientFetch: typeof fetch = async (input, init) => {
  const method = (init?.method ?? 'GET').toUpperCase();
  const isRead = method === 'GET' || method === 'HEAD';
  if (!isRead) return fetch(input, init);

  const external = init?.signal ?? undefined;
  let lastError: unknown;

  for (let attempt = 0; attempt <= READ_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
    const forward = () => controller.abort();
    external?.addEventListener('abort', forward);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } catch (error) {
      lastError = error;
      // A caller-initiated abort is a decision, not a failure to paper over.
      if (external?.aborted) throw error;
      if (attempt === READ_RETRIES) throw error;
      await sleep(300 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', forward);
    }
  }

  throw lastError;
};

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  realtime: {
    // Tighter than the 30s default: the heartbeat is what surfaces a socket
    // the network dropped without closing, and until it fires the client
    // believes it is still receiving messages. 15s halves that blind window.
    heartbeatIntervalMs: 15_000,
    timeout: 20_000,
    // Reconnect aggressively at first (a wake or a brief drop usually
    // succeeds immediately) then back off, rather than the default's slow
    // early rungs.
    reconnectAfterMs: (tries: number) =>
      [500, 1_000, 2_000, 5_000, 10_000][tries - 1] ?? 10_000,
  },
  global: { fetch: resilientFetch },
});
