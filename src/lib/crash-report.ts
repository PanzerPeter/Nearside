// What went wrong last time, kept on this device until its owner sends it.
//
// This replaced Firebase Crashlytics, which shipped every crash to Google on
// its own. Here nothing leaves the phone unasked: a native crash is written to
// a private file by `NearsideApp.java`, a JavaScript one to localStorage below,
// and on the next launch `CrashPrompt` offers to email the lot — opening the
// mail app with the text in the body, where it can be read, cut or discarded
// before anything is sent. No account id, no message content; the trace and
// the version are the whole report.
//
// What it costs: no dashboard, no grouping, no automatic de-obfuscation (a
// release trace needs `retrace` with that build's mapping.txt), and a crash is
// only heard about when somebody chooses to send it.

import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { APP_VERSION } from './version';
import { CONTACT_EMAIL } from './legal';
import { isMobileNative } from './platform';

/** Written by `NearsideApp.java` into `getFilesDir()`, which is `Directory.Data`. */
const NATIVE_FILE = 'crash-report.txt';
const JS_KEY = 'nearside.crash.js';

/** A few, not a history: the last fatal one and what led up to it. */
const KEEP = 5;
/** Per entry. A stack is a few kB; a giant `reason` string is not a stack. */
const ENTRY_MAX = 4000;

interface JsEntry {
  at: string;
  /** `fatal` took the screen down (the error boundary); a `rejection` did not
   *  and is kept only as context — on its own it never prompts anybody. */
  kind: 'fatal' | 'rejection';
  text: string;
}

function readJs(): JsEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(JS_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as JsEntry[]) : [];
  } catch {
    return [];
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack ?? ''}`;
  return String(error);
}

export function recordJsError(kind: JsEntry['kind'], error: unknown, extra = ''): void {
  const entry: JsEntry = {
    at: new Date().toISOString(),
    kind,
    text: (describe(error) + (extra ? `\n${extra}` : '')).slice(0, ENTRY_MAX),
  };
  try {
    localStorage.setItem(JS_KEY, JSON.stringify([...readJs(), entry].slice(-KEEP)));
  } catch {
    // Storage off or full. Losing a crash report is not worth a second failure.
  }
}

async function readNative(): Promise<string | null> {
  if (!isMobileNative()) return null;
  try {
    const { data } = await Filesystem.readFile({
      path: NATIVE_FILE,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    return typeof data === 'string' && data.trim() ? data : null;
  } catch {
    // No file is the normal case.
    return null;
  }
}

/** The report as it would be sent, or null when there is nothing worth asking about. */
export async function pendingCrashReport(): Promise<string | null> {
  return composeReport(await readNative(), readJs(), APP_VERSION, navigator.userAgent);
}

/** Pure, so what a report contains — and when there is one — is tested. */
export function composeReport(
  native: string | null,
  js: readonly JsEntry[],
  version: string,
  userAgent: string
): string | null {
  if (!native && !js.some((e) => e.kind === 'fatal')) return null;
  return [
    `Nearside ${version}`,
    userAgent,
    native,
    ...js.map((e) => `[${e.at}] ${e.kind}\n${e.text}`),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function clearCrashReport(): Promise<void> {
  try {
    localStorage.removeItem(JS_KEY);
  } catch {
    // See recordJsError.
  }
  if (isMobileNative()) {
    await Filesystem.deleteFile({ path: NATIVE_FILE, directory: Directory.Data }).catch(() => {});
  }
}

/**
 * A `mailto:` link carrying the report.
 *
 * Capped, because a mail client handed a URL of tens of kilobytes either
 * truncates it somewhere arbitrary or refuses to open; the top of a trace is
 * the part that names the failure.
 */
export function crashMailto(report: string, max = 6000): string {
  const body = report.length > max ? report.slice(0, max) + '\n…' : report;
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Nearside crash report')}&body=${encodeURIComponent(body)}`;
}
