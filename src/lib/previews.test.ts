import { describe, expect, it } from 'vitest';
import { previewProbeKey, stalePreviews } from './previews';

const row = (peer_id: string, last_at: string | null) => ({ peer_id, last_at });

describe('stalePreviews', () => {
  it('asks for a conversation the mirror has never seen', () => {
    const rows = [row('alice', '2026-08-17T10:00:00Z')];
    expect(stalePreviews(rows, new Map(), new Set(), 10)).toEqual(['alice']);
  });

  // The whole point: a message arrived while the thread was closed, so the
  // newest thing the mirror holds is older than the newest thing the server
  // says exists.
  it('asks again when the server has something newer than the mirror', () => {
    const rows = [row('alice', '2026-08-17T10:00:00Z')];
    const cached = new Map([['alice', '2026-08-17T09:00:00Z']]);
    expect(stalePreviews(rows, cached, new Set(), 10)).toEqual(['alice']);
  });

  it('leaves a conversation alone once its newest message is mirrored', () => {
    const rows = [row('alice', '2026-08-17T10:00:00Z')];
    const cached = new Map([['alice', '2026-08-17T10:00:00Z']]);
    expect(stalePreviews(rows, cached, new Set(), 10)).toEqual([]);
  });

  it('ignores a conversation with no messages at all', () => {
    expect(stalePreviews([row('alice', null)], new Map(), new Set(), 10)).toEqual([]);
  });

  // An uncaptioned photo has no body to open, so the probe comes back with
  // nothing and the mirror stays where it was. Without this the same row would
  // be re-fetched on every list refresh, for ever.
  it('does not re-probe a message it has already tried', () => {
    const rows = [row('alice', '2026-08-17T10:00:00Z')];
    const attempted = new Set([previewProbeKey('alice', '2026-08-17T10:00:00Z')]);
    expect(stalePreviews(rows, new Map(), attempted, 10)).toEqual([]);
  });

  it('probes again when a newer message arrives after a failed attempt', () => {
    const rows = [row('alice', '2026-08-17T11:00:00Z')];
    const attempted = new Set([previewProbeKey('alice', '2026-08-17T10:00:00Z')]);
    expect(stalePreviews(rows, new Map(), attempted, 10)).toEqual(['alice']);
  });

  // A cold start on an account with forty contacts must not open forty
  // queries at once; the rows nearest the top are the ones being read.
  it('takes the most recent conversations first and stops at the cap', () => {
    const rows = [
      row('old', '2026-08-01T10:00:00Z'),
      row('newest', '2026-08-17T10:00:00Z'),
      row('middle', '2026-08-10T10:00:00Z'),
    ];
    expect(stalePreviews(rows, new Map(), new Set(), 2)).toEqual(['newest', 'middle']);
  });
});
