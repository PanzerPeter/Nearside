// Writing the open conversation out as a text file.
//
// The read is `cachedConversation`, which is the same local mirror search and
// the panel read, and for the same reason: the server has held no message
// bodies since 0023. So this is a local read and a file write, with no request
// and no third party — which is the point of the feature, not a limitation of
// it. `lib/export-chat.ts` decides what the file says.

import { useState } from 'react';
import { cachedConversation } from '../lib/localdb';
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
}

export function useExportChat({
  conversationId,
  title,
  me,
  meLabel,
  nameFor,
}: ExportOptions): ChatExport {
  const [busy, setBusy] = useState(false);

  async function run(): Promise<number | null> {
    setBusy(true);
    try {
      const rows = (await cachedConversation(conversationId)) as TranscriptRow[];
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
