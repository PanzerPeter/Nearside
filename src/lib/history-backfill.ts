// Walking a conversation back to its first message, so the local mirror holds
// all of it rather than the part somebody happened to scroll.
//
// Everything this device can say about a conversation it reads from the mirror
// (`localdb.ts`): search, the "in this conversation" panel, the transcript
// export. The mirror is filled by opening messages, and until now the only
// thing that opened them was painting them — so the answers were drawn from
// the last page or two and given as though they were drawn from the chat. A
// search that finds nothing looks exactly like a word nobody said.
//
// So: fetch the conversation page by page, oldest-ward, opening each page as
// it lands. Opening is what mirrors it (`openRows`, `openRoomRows`), which is
// why the caller supplies the fetch — a 1:1 page needs the peer's public key
// and a room page needs the room key and a signature check, and neither belongs
// in a loop that only knows how to count pages.
//
// The driver is here, pure and injected, because the parts worth being sure of
// are the stopping conditions: a walk that never ends spends somebody's data,
// and one that stops early is the bug it was written to fix.

/** Where the next page starts. Ordered by `created_at` then `id`, matching the
 *  order the message queries page in — two rows can share a timestamp to the
 *  microsecond, and a cursor of time alone steps over one of them. */
export interface HistoryCursor {
  created_at: string;
  id: string;
}

export interface BackfillProgress {
  /** Pages fetched in this run. */
  pages: number;
  /** Rows fetched in this run — not rows newly mirrored: a page already opened
   *  on this device is counted here and changes nothing in the mirror. */
  rows: number;
  /** The oldest message has been reached; there is nothing left to fetch. */
  complete: boolean;
  /** Where the next run resumes, or null if it would start from the newest. */
  cursor: HistoryCursor | null;
}

export interface BackfillOptions {
  /** Resume point from the last run. Null starts at the newest message. */
  start: HistoryCursor | null;
  /**
   * One page older than `cursor`, newest first. Must also *open* the rows —
   * that is what writes them to the mirror, and it is the whole point of the
   * walk. A short page (fewer than a full page) is taken as the end.
   */
  fetchOlder(cursor: HistoryCursor | null): Promise<readonly HistoryCursor[]>;
  /** Rows per page, so a short page can be recognised as the end. */
  pageSize: number;
  /** Called after each page with the bookmark to persist. Per page rather than
   *  at the end: the walk is interrupted by the ordinary things — the panel
   *  closing, the app going away — and a walk that always restarts from the
   *  newest message never finishes a long conversation. */
  onPage(progress: BackfillProgress): void | Promise<void>;
  /** Checked before each page. False abandons the run where it is, bookmark
   *  intact. */
  keepGoing?: () => boolean;
  /**
   * A ceiling on one run. Not a limit on how far back the mirror goes — the
   * next run resumes from the bookmark — but a promise that asking to search
   * cannot turn into an unbounded burst of requests on a conversation with
   * years in it.
   */
  maxPages?: number;
}

export const DEFAULT_MAX_PAGES = 120;

/** The oldest of a page, by the same (created_at, id) order the queries use. */
export function oldestOf(rows: readonly HistoryCursor[]): HistoryCursor | null {
  let oldest: HistoryCursor | null = null;
  for (const row of rows) {
    if (!oldest) {
      oldest = row;
      continue;
    }
    if (row.created_at < oldest.created_at) oldest = row;
    else if (row.created_at === oldest.created_at && row.id < oldest.id) oldest = row;
  }
  return oldest;
}

/**
 * Page back through a conversation until it runs out, is capped, or is called
 * off.
 *
 * A failing fetch is not caught here: the caller decides whether a dropped
 * connection mid-walk is worth saying anything about, and the bookmark written
 * by the last successful page is what makes stopping harmless.
 */
export async function runBackfill(options: BackfillOptions): Promise<BackfillProgress> {
  const { start, fetchOlder, pageSize, onPage, keepGoing, maxPages = DEFAULT_MAX_PAGES } = options;

  let progress: BackfillProgress = { pages: 0, rows: 0, complete: false, cursor: start };

  while (progress.pages < maxPages) {
    if (keepGoing && !keepGoing()) return progress;

    const page = await fetchOlder(progress.cursor);
    const oldest = oldestOf(page);

    progress = {
      pages: progress.pages + 1,
      rows: progress.rows + page.length,
      // An empty page is the end of the conversation. So is a short one: the
      // query asked for `pageSize` and the server had fewer, which it can only
      // mean here — rows are never filtered out between the query and this.
      complete: page.length < pageSize,
      // Kept, not nulled, when a page comes back empty: the bookmark is what a
      // later run would resume from if `complete` were ever cleared.
      cursor: oldest ?? progress.cursor,
    };

    await onPage(progress);
    if (progress.complete) return progress;
  }

  return progress;
}
