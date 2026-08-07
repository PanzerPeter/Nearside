import { describe, expect, it } from 'vitest';
import { TABLE_REPORTS, missingTables, unlistedTables } from './server-view';

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
});
