// A conversation, written out as a plain text file.
//
// The whole feature is a consequence of where the plaintext lives. The server
// has held no message bodies since 0023, so there is nothing to export from it
// and no endpoint to build; what this device decrypted is in `localdb.ts`, and
// writing that to a file is a local read and nothing else. Nothing leaves the
// phone, nothing is uploaded, and no third party is involved in a feature whose
// entire point is that the conversation is yours.
//
// Plain text rather than JSON or a zip of attachments. A transcript's job is to
// be readable in ten years by something that is not this app — a court, an
// accountant, a person who wants their own words back — and every format with
// more structure than this is one more thing that has to still be readable
// then. Attachments are deliberately not included: they are files on the
// device already, and a transcript that silently omits half a conversation's
// pictures would be worse than one that says so.

import { t } from './i18n';

/** A row as the mirror holds it — decrypted text and who wrote it. */
export interface TranscriptRow {
  user_id: string;
  text: string;
  created_at: string;
}

export interface TranscriptOptions {
  /** What the conversation is called, for the header and the filename. */
  title: string;
  /** How to name whoever wrote a line, the viewer included — build one with
   *  `transcriptNamer`. A 1:1 chat answers with two names; a group answers
   *  with one per member. */
  nameFor: (userId: string) => string;
  /** Rendered into the header. Passed in rather than read here so the same
   *  transcript can be produced twice and compared. */
  exportedAt: Date;
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * `YYYY-MM-DD HH:MM`, in the reader's own time zone.
 *
 * Local rather than UTC, and deliberately: a transcript is read by the person
 * who was in the conversation, and "we agreed at 14:00" has to match what their
 * phone said at the time. The offset goes in the header so the file still says
 * which clock it is on.
 */
export function stampFor(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return (
    `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ` +
    `${two(at.getHours())}:${two(at.getMinutes())}`
  );
}

/** The zone the stamps are in, as the header names it. */
function zoneLabel(at: Date): string {
  const minutes = -at.getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`;
}

/**
 * A file name for the transcript.
 *
 * Everything a filesystem might object to becomes a hyphen, and runs collapse:
 * a group called "Dinner :: Friday??" must not produce a name that Windows
 * refuses and Android silently truncates.
 */
export function transcriptFilename(title: string, at: Date): string {
  const safe =
    title
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, '-')
      .slice(0, 60) || 'conversation';
  return `nearside-${safe}-${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}.txt`;
}

/**
 * The transcript.
 *
 * Rows are given newest first, the way every read in this app returns them, and
 * are reversed here: a conversation is read downwards.
 *
 * A message with no text — an attachment with no caption — contributes no line.
 * It is not that its existence is hidden, it is that this format has nothing to
 * say about a picture, and a row reading "[image]" in a transcript somebody may
 * rely on is an invented record of something the file does not contain. The
 * count in the header is the honest version: it says how many lines there are,
 * not how many messages were sent.
 */
export function formatTranscript(
  rows: readonly TranscriptRow[],
  { title, nameFor, exportedAt }: TranscriptOptions
): string {
  const oldestFirst = [...rows].reverse();
  const lines = oldestFirst
    .filter((row) => row.text.trim().length > 0)
    .map((row) => `[${stampFor(row.created_at)}] ${nameFor(row.user_id)}: ${row.text}`);

  const header = [
    `Nearside — ${title}`,
    t('transcript.exported', {
      when: stampFor(exportedAt.toISOString()),
      zone: zoneLabel(exportedAt),
    }),
    t('transcript.messages', { count: lines.length }),
    '',
    // The two limits that make this file what it is, said in the file rather
    // than only in a dialog nobody keeps. One line rather than three: the
    // hand-wrapping only held for the English wording.
    t('transcript.note'),
    '',
    '---',
    '',
  ].join('\n');

  return header + lines.join('\n') + '\n';
}

/** Whoever wrote a line, as the transcript names them. */
export function transcriptNamer(
  me: string,
  meLabel: string,
  nameFor: (userId: string) => string
): (userId: string) => string {
  return (userId) => (userId === me ? meLabel : nameFor(userId));
}
