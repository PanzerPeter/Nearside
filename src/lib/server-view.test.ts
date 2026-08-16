import { describe, expect, it } from 'vitest';
import {
  TABLE_GROUPS,
  TABLE_REPORTS,
  groupTables,
  missingTables,
  type TableReport,
  unlistedTables,
} from './server-view';

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

  it('admits that room titles and nicknames are readable text', () => {
    expect(TABLE_REPORTS.find((t) => t.table === 'rooms')?.readable).toContain('title');
    expect(TABLE_REPORTS.find((t) => t.table === 'friend_nicknames')?.readable).toContain(
      'nickname'
    );
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
