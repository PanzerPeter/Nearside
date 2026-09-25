/**
 * Reporting a contact.
 *
 * The server holds no message text, so a report about what someone said can
 * only carry what the reporter's own device decrypted — and only if they
 * choose to send it. The excerpt is the last `REPORT_MESSAGE_LIMIT` messages
 * of the conversation, by id and text; the `report-user` function looks each
 * id up itself, so who sent a message and when come from the server rather
 * than from this device. It emails the ticket and keeps no text.
 */

import { supabase } from './supabase';
import type { Message } from './types';
import type { MessageKey } from './i18n';

/** Mirrors MESSAGE_LIMIT in supabase/functions/report-user. */
export const REPORT_MESSAGE_LIMIT = 30;
export const REPORT_REASON_MAX = 2000;

export interface ReportLine {
  id: string;
  text: string | null;
}

/**
 * The newest messages of a conversation, oldest first, as the report sends
 * them.
 *
 * Only rows the server has: a queued message never reached it, so there is
 * nothing to match it against. A deleted message keeps its place — the server
 * says it was deleted — and a body this device could not open goes as no text
 * rather than as the placeholder the bubble draws.
 */
export function reportExcerpt(
  messages: readonly Message[],
  limit = REPORT_MESSAGE_LIMIT
): ReportLine[] {
  return [...messages]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(-limit)
    .map((m) => ({
      id: m.id,
      text: m.deleted_at || m.decrypt_failed ? null : m.text,
    }));
}

/** What went wrong, as the key the modal shows. */
export function reportErrorKey(code: string | undefined): MessageKey {
  if (code === 'rate-limited') return 'report.rateLimited';
  return 'report.failed';
}

/** Resolves to the ticket number, or throws with the key to show. */
export async function sendReport(
  reportedId: string,
  reason: string,
  lines: readonly ReportLine[]
): Promise<string> {
  let result: Awaited<ReturnType<typeof supabase.functions.invoke<{ ticket?: string }>>>;
  try {
    result = await supabase.functions.invoke<{ ticket?: string }>('report-user', {
      body: { reported_id: reportedId, reason: reason.slice(0, REPORT_REASON_MAX), messages: lines },
    });
  } catch {
    // A transport failure, not an answer — the caller shows the key, and a
    // raw fetch error is no sentence to put in front of anybody.
    throw new Error(reportErrorKey(undefined));
  }
  const { data, error } = result;
  if (error || !data?.ticket) {
    // supabase-js hides a non-2xx body behind `error.context`, a Response.
    let code: string | undefined;
    try {
      const context = (error as { context?: Response } | null)?.context;
      code = context ? ((await context.json()) as { error?: string }).error : undefined;
    } catch {
      code = undefined;
    }
    throw new Error(reportErrorKey(code));
  }
  return String(data.ticket);
}
