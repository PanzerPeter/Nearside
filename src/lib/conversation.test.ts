import { describe, expect, it } from 'vitest';
import {
  classifyMedia,
  conversationFilter,
  conversationKey,
  fileExtension,
  isConversationFolder,
  isSelfChat,
  mediaPath,
  messageSnippet,
  sortConversations,
} from './conversation';
import type { Message } from './types';

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';

function file(name: string, type: string): File {
  return new File(['x'], name, { type });
}

describe('conversationKey', () => {
  it('is independent of argument order', () => {
    expect(conversationKey(A, B)).toBe(conversationKey(B, A));
  });

  it('joins the two ids with an underscore in sorted order', () => {
    expect(conversationKey(B, A)).toBe(`${A}_${B}`);
  });
});

describe('isSelfChat', () => {
  it('recognises your own id as the self-chat', () => {
    expect(isSelfChat(A, A)).toBe(true);
  });

  it('is false for a friend, and for no peer at all', () => {
    expect(isSelfChat(A, B)).toBe(false);
    expect(isSelfChat(A, null)).toBe(false);
    expect(isSelfChat(A, undefined)).toBe(false);
  });
});

describe('sortConversations', () => {
  const C = '00000000-0000-0000-0000-00000000000c';
  const row = (peer_id: string, username: string, last_at: string | null) => ({
    peer_id,
    username,
    last_at,
  });
  const names = (rows: { username: string }[]) => rows.map((r) => r.username);

  it('pins the self row first even when it is the least recent', () => {
    const rows = [
      row(B, 'bob', '2026-01-02T00:00:00Z'),
      row(A, 'me', '2020-01-01T00:00:00Z'),
      row(C, 'caz', '2026-01-03T00:00:00Z'),
    ];
    expect(names(sortConversations(rows, A))).toEqual(['me', 'caz', 'bob']);
  });

  it('pins the self row first even when it has never been used', () => {
    const rows = [row(B, 'bob', '2026-01-02T00:00:00Z'), row(A, 'me', null)];
    expect(names(sortConversations(rows, A))).toEqual(['me', 'bob']);
  });

  it('orders everyone else newest first', () => {
    const rows = [
      row(B, 'bob', '2026-01-01T00:00:00Z'),
      row(C, 'caz', '2026-01-03T00:00:00Z'),
    ];
    expect(names(sortConversations(rows, A))).toEqual(['caz', 'bob']);
  });

  it('sinks a friend with no messages below one with messages', () => {
    const rows = [row(B, 'bob', null), row(C, 'caz', '2026-01-01T00:00:00Z')];
    expect(names(sortConversations(rows, A))).toEqual(['caz', 'bob']);
  });

  it('compares instants, not strings', () => {
    // Same moment, two shapes PostgREST can hand back. Lexicographic order
    // would put the offset form first and reshuffle the list on every poll.
    const rows = [
      row(B, 'bob', '2026-01-01T10:00:00Z'),
      row(C, 'caz', '2026-01-01T13:00:00+02:00'),
    ];
    expect(names(sortConversations(rows, A))).toEqual(['caz', 'bob']);
  });

  it('breaks ties on username so the order is total', () => {
    const at = '2026-01-01T00:00:00Z';
    const forward = sortConversations([row(C, 'caz', at), row(B, 'bob', at)], A);
    const reversed = sortConversations([row(B, 'bob', at), row(C, 'caz', at)], A);
    expect(names(forward)).toEqual(['bob', 'caz']);
    expect(names(reversed)).toEqual(names(forward));
  });

  it('does not mutate the array it was given', () => {
    const rows = [row(B, 'bob', null), row(A, 'me', null)];
    sortConversations(rows, A);
    expect(names(rows)).toEqual(['bob', 'me']);
  });
});

describe('conversationFilter', () => {
  it('matches both directions of the conversation', () => {
    const filter = conversationFilter(A, B);
    expect(filter).toContain(`and(user_id.eq.${A},receiver_id.eq.${B})`);
    expect(filter).toContain(`and(user_id.eq.${B},receiver_id.eq.${A})`);
  });
});

describe('mediaPath', () => {
  it('namespaces the file under the order-independent conversation key', () => {
    expect(mediaPath(B, A, 'photo.png')).toBe(`${A}_${B}/photo.png`);
  });
});

describe('isConversationFolder', () => {
  const C = '00000000-0000-0000-0000-00000000000c';

  it('matches when uid is the first segment', () => {
    expect(isConversationFolder(`${A}_${B}`, A)).toBe(true);
  });

  it('matches when uid is the second segment', () => {
    expect(isConversationFolder(`${A}_${B}`, B)).toBe(true);
  });

  it('rejects a folder for two other users', () => {
    expect(isConversationFolder(`${A}_${B}`, C)).toBe(false);
  });

  it('rejects a three-segment folder even if uid is one of the segments', () => {
    expect(isConversationFolder(`${A}_${B}_${C}`, A)).toBe(false);
  });

  it('rejects a segment that only has uid as a prefix', () => {
    expect(isConversationFolder(`${A}x_${B}`, A)).toBe(false);
  });

  it('rejects a segment that only has uid as a suffix', () => {
    expect(isConversationFolder(`x${A}_${B}`, A)).toBe(false);
  });

  it('rejects a bare uid with no underscore', () => {
    expect(isConversationFolder(A, A)).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(isConversationFolder('', A)).toBe(false);
  });
});

describe('classifyMedia', () => {
  it('classifies accepted image types', () => {
    expect(classifyMedia(file('a.png', 'image/png'))).toBe('image');
    expect(classifyMedia(file('a.webp', 'image/webp'))).toBe('image');
  });

  it('classifies accepted video types', () => {
    expect(classifyMedia(file('a.mp4', 'video/mp4'))).toBe('video');
    expect(classifyMedia(file('a.mov', 'video/quicktime'))).toBe('video');
  });

  it('rejects types outside the allow-list', () => {
    expect(classifyMedia(file('a.pdf', 'application/pdf'))).toBeNull();
    expect(classifyMedia(file('a.svg', 'image/svg+xml'))).toBeNull();
  });
});

describe('fileExtension', () => {
  it('prefers the extension from the filename, lowercased', () => {
    expect(fileExtension(file('Holiday.JPEG', 'image/jpeg'))).toBe('jpeg');
  });

  it('falls back to the MIME subtype when the name has no extension', () => {
    expect(fileExtension(file('clipboard', 'image/png'))).toBe('png');
  });
});

describe('messageSnippet', () => {
  function message(overrides: Partial<Message> = {}): Message {
    return {
      id: '1',
      user_id: A,
      receiver_id: B,
      content: null,
      media_path: null,
      media_type: null,
      media_duration_ms: null,
      reply_to_id: null,
      forwarded: false,
      edited_at: null,
      deleted_at: null,
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it('quotes the body when there is one', () => {
    expect(messageSnippet(message({ content: 'see you at six' }))).toBe('see you at six');
  });

  it('prefers a caption over the attachment it describes', () => {
    expect(messageSnippet(message({ content: 'look', media_path: 'p.jpg', media_type: 'image' })))
      .toBe('look');
  });

  it('names media that has no caption of its own', () => {
    expect(messageSnippet(message({ media_path: 'a.webm', media_type: 'audio' }))).toBe(
      '🎤 Voice message'
    );
    expect(messageSnippet(message({ media_path: 'p.jpg', media_type: 'image' }))).toBe('📷 Photo');
    expect(messageSnippet(message({ media_path: 'v.mp4', media_type: 'video' }))).toBe('🎬 Video');
  });

  it('never leaks the body of a deleted message', () => {
    expect(messageSnippet(message({ content: 'oops', deleted_at: new Date().toISOString() }))).toBe(
      'Deleted message'
    );
  });
});
