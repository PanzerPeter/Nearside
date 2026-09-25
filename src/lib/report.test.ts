import { describe, expect, it } from 'vitest';
import { REPORT_MESSAGE_LIMIT, reportErrorKey, reportExcerpt } from './report';
import type { Message } from './types';

function row(n: number, extra: Partial<Message> = {}): Message {
  return {
    id: `id-${n}`,
    user_id: 'a',
    receiver_id: 'b',
    ciphertext: 'c',
    nonce: 'n',
    text: `message ${n}`,
    media_path: null,
    media_type: null,
    media_thumb_path: null,
    media_key_ciphertext: null,
    media_key_nonce: null,
    media_duration_ms: null,
    reply_to_id: null,
    forwarded: false,
    sealed_prompt: false,
    edited_at: null,
    deleted_at: null,
    expires_at: null,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
    ...extra,
  };
}

describe('reportExcerpt', () => {
  it('sends the newest messages, oldest first, and no more than the limit', () => {
    const rows = Array.from({ length: 45 }, (_, i) => row(i)).reverse();
    const excerpt = reportExcerpt(rows);
    expect(excerpt).toHaveLength(REPORT_MESSAGE_LIMIT);
    expect(excerpt[0].id).toBe('id-15');
    expect(excerpt[excerpt.length - 1].id).toBe('id-44');
  });

  // A deleted message or one this device could not open has no text to give.
  // Sending the bubble's placeholder would put words in the ticket nobody wrote.
  it('never sends text for a deleted or unopenable message', () => {
    const excerpt = reportExcerpt([
      row(1, { deleted_at: '2026-01-01T00:05:00Z', text: 'gone' }),
      row(2, { decrypt_failed: true, text: 'placeholder' }),
    ]);
    expect(excerpt.map((l) => l.text)).toEqual([null, null]);
  });
});

describe('reportErrorKey', () => {
  it('names the rate limit and folds everything else into one message', () => {
    expect(reportErrorKey('rate-limited')).toBe('report.rateLimited');
    expect(reportErrorKey('email-failed')).toBe('report.failed');
    expect(reportErrorKey(undefined)).toBe('report.failed');
  });
});
