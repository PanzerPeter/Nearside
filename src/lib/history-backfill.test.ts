import { describe, expect, it } from 'vitest';
import { oldestOf, runBackfill, type HistoryCursor } from './history-backfill';

/** A conversation of `n` messages, newest first, one second apart. */
function conversation(n: number): HistoryCursor[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${n - i}`,
    created_at: new Date(1_700_000_000_000 - i * 1000).toISOString(),
  }));
}

/** The server's paging, as the two real fetchers implement it. */
function pager(rows: HistoryCursor[], pageSize: number) {
  const calls: (HistoryCursor | null)[] = [];
  return {
    calls,
    fetchOlder: async (cursor: HistoryCursor | null) => {
      calls.push(cursor);
      const older = cursor
        ? rows.filter(
            (r) =>
              r.created_at < cursor.created_at ||
              (r.created_at === cursor.created_at && r.id < cursor.id)
          )
        : rows;
      return older.slice(0, pageSize);
    },
  };
}

describe('oldestOf', () => {
  it('breaks a timestamp tie on the id, like the queries do', () => {
    const at = '2026-09-01T10:00:00.000Z';
    expect(oldestOf([{ id: 'b', created_at: at }, { id: 'a', created_at: at }])).toEqual({
      id: 'a',
      created_at: at,
    });
  });

  it('has no answer for an empty page', () => {
    expect(oldestOf([])).toBeNull();
  });
});

describe('runBackfill', () => {
  it('walks to the oldest message and says so', async () => {
    const rows = conversation(95);
    const { fetchOlder, calls } = pager(rows, 30);

    const result = await runBackfill({ start: null, fetchOlder, pageSize: 30, onPage: () => {} });

    expect(result.complete).toBe(true);
    expect(result.rows).toBe(95);
    // 30 + 30 + 30 + 5: the short page is the end, and nothing is asked for
    // after it.
    expect(calls).toHaveLength(4);
    expect(result.cursor?.id).toBe('m1');
  });

  it('takes an exhausted conversation as complete when the last page is empty', async () => {
    const rows = conversation(60);
    const { fetchOlder } = pager(rows, 30);

    const result = await runBackfill({ start: null, fetchOlder, pageSize: 30, onPage: () => {} });

    expect(result.complete).toBe(true);
    expect(result.rows).toBe(60);
  });

  it('resumes from the bookmark rather than the newest message', async () => {
    const rows = conversation(90);
    const { fetchOlder, calls } = pager(rows, 30);

    const first = await runBackfill({
      start: null,
      fetchOlder,
      pageSize: 30,
      onPage: () => {},
      maxPages: 1,
    });
    expect(first.complete).toBe(false);

    const second = await runBackfill({
      start: first.cursor,
      fetchOlder,
      pageSize: 30,
      onPage: () => {},
    });

    expect(second.complete).toBe(true);
    // The resumed run never asks for the first page again.
    expect(calls[1]).toEqual(first.cursor);
    expect(first.rows + second.rows).toBe(90);
  });

  it('stops where it is when called off, keeping the bookmark', async () => {
    const rows = conversation(300);
    const { fetchOlder } = pager(rows, 30);
    let pages = 0;

    const result = await runBackfill({
      start: null,
      fetchOlder,
      pageSize: 30,
      onPage: () => {
        pages += 1;
      },
      keepGoing: () => pages < 2,
    });

    expect(result.complete).toBe(false);
    expect(result.pages).toBe(2);
    expect(result.cursor).not.toBeNull();
  });

  it('caps one run, so opening search cannot become an unbounded burst', async () => {
    const rows = conversation(1000);
    const { fetchOlder, calls } = pager(rows, 30);

    const result = await runBackfill({
      start: null,
      fetchOlder,
      pageSize: 30,
      onPage: () => {},
      maxPages: 3,
    });

    expect(calls).toHaveLength(3);
    expect(result.complete).toBe(false);
  });

  it('reports every page as it lands, so a bookmark survives an interruption', async () => {
    const rows = conversation(70);
    const { fetchOlder } = pager(rows, 30);
    const seen: number[] = [];

    await runBackfill({
      start: null,
      fetchOlder,
      pageSize: 30,
      onPage: (p) => {
        seen.push(p.rows);
      },
    });

    expect(seen).toEqual([30, 60, 70]);
  });
});
