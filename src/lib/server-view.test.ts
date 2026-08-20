import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TABLE_GROUPS,
  TABLE_REPORTS,
  columnDrift,
  groupTables,
  missingTables,
  type TableReport,
  unlistedTables,
} from './server-view';

/**
 * table → columns, read out of `supabase/schema.sql`.
 *
 * The screen checks itself against the live database at runtime (0043). This
 * checks it against the schema at build time, which is the difference between
 * a user being told the page is incomplete and the page never shipping
 * incomplete. Block comments are stripped first — the schema is mostly prose —
 * and constraint lines are skipped, since a CHECK is not a column.
 */
function schemaColumns(): Map<string, string[]> {
  const sql = readFileSync(new URL('../../supabase/schema.sql', import.meta.url), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  );
  const tables = new Map<string, string[]>();
  for (const match of sql.matchAll(
    /CREATE TABLE IF NOT EXISTS public\.(\w+) \(([\s\S]*?)\n\);/g
  )) {
    const columns: string[] = [];
    for (const raw of match[2].split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('--')) continue;
      if (/^(PRIMARY KEY|UNIQUE|CONSTRAINT|FOREIGN KEY|CHECK)\b/i.test(line)) continue;
      const name = line.split(/\s+/)[0];
      // Continuation lines of a multi-line CHECK reach here as fragments.
      if (/^[a-z_][a-z0-9_]*$/.test(name)) columns.push(name);
    }
    tables.set(match[1], columns);
  }
  return tables;
}

/** The specs as the screen renders them, with a row count stubbed in. */
const asReports = (): TableReport[] => TABLE_REPORTS.map((t) => ({ ...t, rows: 0 }));

describe('server view', () => {
  it('classifies every column of every listed table', () => {
    for (const spec of TABLE_REPORTS) {
      expect(spec.readable.length + spec.opaque.length).toBeGreaterThan(0);
      // A column in both lists is a contradiction the user would be shown.
      expect(spec.readable.filter((c) => spec.opaque.includes(c))).toEqual([]);
    }
  });

  it('gives every table a plain-language label and a note', () => {
    for (const spec of TABLE_REPORTS) {
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.note.length).toBeGreaterThan(0);
    }
  });

  it('marks message bodies as opaque and their metadata as readable', () => {
    const messages = TABLE_REPORTS.find((t) => t.table === 'messages');
    expect(messages?.opaque).toContain('ciphertext');
    expect(messages?.opaque).toContain('nonce');
    expect(messages?.readable).toContain('created_at');
    // Honesty: who talks to whom IS visible, and the screen says so.
    expect(messages?.readable).toContain('receiver_id');
  });

  it('marks sealed media keys as opaque', () => {
    const messages = TABLE_REPORTS.find((t) => t.table === 'messages');
    expect(messages?.opaque).toContain('media_key_ciphertext');
    expect(messages?.opaque).toContain('media_key_nonce');
  });

  it('never claims a message body column that no longer exists', () => {
    // 0023 dropped `content`. A screen still describing it would be lying in
    // the direction that flatters us.
    const messages = TABLE_REPORTS.find((t) => t.table === 'messages');
    expect(messages?.readable).not.toContain('content');
    expect(messages?.opaque).not.toContain('content');
  });

  it('marks the chat background image as sealed', () => {
    // The last image this app uploaded in the clear (0039). The path stays
    // readable because the server does hold it; the picture behind it does not.
    const backgrounds = TABLE_REPORTS.find((t) => t.table === 'chat_backgrounds');
    expect(backgrounds?.opaque).toContain('key_ciphertext');
    expect(backgrounds?.opaque).toContain('key_nonce');
    expect(backgrounds?.readable).toContain('media_path');
  });

  it('admits that room titles are readable text', () => {
    expect(TABLE_REPORTS.find((t) => t.table === 'rooms')?.readable).toContain('title');
  });

  it('marks a nickname as sealed while still admitting the old column', () => {
    // 0041 sealed it. The plaintext column survives for rows written before
    // that migration, and the screen keeps naming it until it is dropped —
    // describing the seal alone would claim a migration finished early.
    const nicknames = TABLE_REPORTS.find((t) => t.table === 'friend_nicknames');
    expect(nicknames?.opaque).toContain('nickname_ciphertext');
    expect(nicknames?.opaque).toContain('nickname_nonce');
    expect(nicknames?.readable).toContain('nickname');
  });

  it('lists the profile text as something the server reads', () => {
    // 0040 put it there in the open, deliberately. If it is ever sealed, this
    // test is what says the screen has to be told.
    expect(TABLE_REPORTS.find((t) => t.table === 'profiles')?.readable).toContain('bio');
  });

  it('names each table with its own label and note', () => {
    // Six cards used to carry the note of the table above them — the reader
    // was given the wrong explanation, confidently. Nothing renders the
    // mismatch, so only this catches it.
    for (const spec of TABLE_REPORTS) {
      expect(spec.label).toBe(`server.${spec.table}.label`);
      expect(spec.note).toBe(`server.${spec.table}.note`);
    }
  });

  it('describes every table the schema holds, column for column', () => {
    // The whole point of the screen. A migration that adds a table or a column
    // without describing it fails here, rather than showing a user a page that
    // quietly under-reports what is stored about them.
    const schema = schemaColumns();
    expect(unlistedTables([...schema.keys()])).toEqual([]);
    expect(missingTables([...schema.keys()])).toEqual([]);
    expect(columnDrift(schema)).toEqual([]);
  });

  it('flags a column the database holds and no card describes', () => {
    const schema = new Map([['profiles', [...(TABLE_REPORTS[0].readable ?? []), 'shoe_size']]]);
    expect(columnDrift(schema)).toEqual([
      { table: 'profiles', unlisted: ['shoe_size'], missing: [] },
    ]);
  });

  it('flags a column a card claims and the database no longer has', () => {
    const schema = new Map([['profiles', ['id']]]);
    const [drift] = columnDrift(schema);
    expect(drift.table).toBe('profiles');
    expect(drift.missing).toContain('display_name');
    expect(drift.unlisted).toEqual([]);
  });

  it('says nothing about a table the database does not have', () => {
    // `missingTables` already reports it. Repeating it column by column would
    // bury the one line that matters.
    expect(columnDrift(new Map())).toEqual([]);
  });

  it('seals the room key but not who holds a copy', () => {
    const keys = TABLE_REPORTS.find((t) => t.table === 'room_keys');
    expect(keys?.opaque).toContain('key_ciphertext');
    expect(keys?.readable).toContain('user_id');
  });

  it('flags tables that exist in the schema but are not described', () => {
    expect(unlistedTables(['messages', 'profiles', 'friendships', 'surprise_table'])).toContain(
      'surprise_table'
    );
  });

  it('reports nothing unlisted when the schema matches', () => {
    expect(unlistedTables(TABLE_REPORTS.map((t) => t.table))).toEqual([]);
  });

  it('flags a described table the schema no longer has', () => {
    expect(missingTables(['profiles'])).toContain('messages');
  });

  it('describes each table exactly once', () => {
    const names = TABLE_REPORTS.map((t) => t.table);
    expect(new Set(names).size).toBe(names.length);
  });

  it('describes the tables the newer features added', () => {
    // Both shipped without a description, so the screen was showing its own
    // "this screen is out of date" warning to every user.
    const sealed = TABLE_REPORTS.find((t) => t.table === 'sealed_answers');
    expect(sealed?.opaque).toContain('ciphertext');
    // Honesty: the server sees *that* you answered — that is what unlocks the
    // other answer — and the screen must not imply otherwise.
    expect(sealed?.readable).toContain('created_at');

    const stickers = TABLE_REPORTS.find((t) => t.table === 'stickers');
    expect(stickers?.opaque).toContain('label_ciphertext');
    expect(stickers?.opaque).toContain('key_ciphertext');
    // A plaintext label would be a searchable index of the drawer.
    expect(stickers?.readable).not.toContain('label');
  });

  it('admits the flag that marks a message as a sealed question', () => {
    expect(TABLE_REPORTS.find((t) => t.table === 'messages')?.readable).toContain('sealed_prompt');
  });

  it('files every table under a heading that exists', () => {
    const known = new Set(TABLE_GROUPS.map((g) => g.group));
    for (const spec of TABLE_REPORTS) expect(known.has(spec.group)).toBe(true);
  });

  it('loses no table when grouping, and keeps heading order', () => {
    const grouped = groupTables(asReports());
    expect(grouped.flatMap((g) => g.tables).length).toBe(TABLE_REPORTS.length);
    expect(grouped.map((g) => g.group)).toEqual(['content', 'about-you', 'plumbing']);
  });

  it('drops a heading with nothing under it rather than rendering it empty', () => {
    const onlyPlumbing = asReports().filter((t) => t.group === 'plumbing');
    expect(groupTables(onlyPlumbing).map((g) => g.group)).toEqual(['plumbing']);
  });

  it('files message bodies as content and routing metadata as about-you', () => {
    expect(TABLE_REPORTS.find((t) => t.table === 'messages')?.group).toBe('content');
    expect(TABLE_REPORTS.find((t) => t.table === 'friendships')?.group).toBe('about-you');
    // Plumbing is the group whose promise is "nothing about you", so a table
    // holding user rows must never land there.
    for (const spec of TABLE_REPORTS.filter((t) => t.group === 'plumbing')) {
      expect(spec.infrastructure).toBe(true);
    }
  });
});
