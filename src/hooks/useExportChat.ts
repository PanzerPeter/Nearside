// Writing the open conversation out as a text file.
//
// The read is `cachedConversation`, which is the same local mirror search and
// the panel read, and for the same reason: the server has held no message
// bodies since 0023. So the file is built from a local read, with no third
// party — which is the point of the feature, not a limitation of it.
// `lib/export-chat.ts` decides what the file says.
//
// `prepare` is the one request the export does make, indirectly: the mirror is
// filled by opening messages, so a conversation this device has only ever
// scrolled the end of is mirrored only at the end. The walk that fixes that
// (`useHistoryBackfill`) runs before the read, because a transcript missing
// last year is a transcript nobody can tell is missing last year.

import { useState } from 'react';
import { EXPORT_LIMIT, cachedConversation } from '../lib/localdb';
import { saveTextFile } from '../lib/download';
import {
  formatTranscript,
  transcriptFilename,
  transcriptNamer,
  type TranscriptRow,
} from '../lib/export-chat';

export interface ChatExport {
  /** True while the file is being built and written. A long conversation is a
   *  thousand rows out of SQLite and a string the size of the whole chat. */
  busy: boolean;
  /** Resolves to the number of lines written, or null if it could not be
   *  saved. The caller owns how either is said. */
  run: () => Promise<number | null>;
}

interface ExportOptions {
  /** The conversation to read: a peer's user id, or a group's id — the mirror
   *  stores both under the same column. */
  conversationId: string;
  title: string;
  me: string;
  meLabel: string;
  nameFor: (userId: string) => string;
  /** Awaited before the mirror is read — where the rest of the conversation is
   *  fetched into it. Without this the file holds whatever happened to have
   *  been opened on this device, which on an old conversation is the last
   *  screenful, and the transcript says nothing about being short. */
  prepare?: () => Promise<void>;
}

export function useExportChat({
  conversationId,
  title,
  me,
  meLabel,
  nameFor,
  prepare,
}: ExportOptions): ChatExport {
  const [busy, setBusy] = useState(false);

  async function run(): Promise<number | null> {
    setBusy(true);
    try {
      await prepare?.();
      // The whole conversation, not the panel's thousand-row window: a
      // transcript that silently stops is worse than a big file.
      const rows = (await cachedConversation(
        conversationId,
        EXPORT_LIMIT
      )) as TranscriptRow[];
      const at = new Date();
      const text = formatTranscript(rows, {
        title,
        nameFor: transcriptNamer(me, meLabel, nameFor),
        exportedAt: at,
      });
      await saveTextFile(text, transcriptFilename(title, at));
      return rows.filter((row) => row.text.trim().length > 0).length;
    } catch {
      return null;
    } finally {
      setBusy(false);
    }
  }

  return { busy, run };
}
