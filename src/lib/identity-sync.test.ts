import { describe, expect, it, vi } from 'vitest';

const updates: Record<string, unknown>[] = [];
vi.mock('./supabase', () => ({
  supabase: {
    from: () => ({
      update: (values: Record<string, unknown>) => {
        updates.push(values);
        return { eq: async () => ({ error: null }) };
      },
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { public_key: null, signing_key: null } }) }),
      }),
    }),
  },
}));

import { publicKeyPayload } from './identity-sync';

describe('identity sync', () => {
  it('publishes only public halves', async () => {
    const identity = {
      boxPublic: new Uint8Array(32).fill(1),
      boxPrivate: new Uint8Array(32).fill(2),
      signPublic: new Uint8Array(32).fill(3),
      signPrivate: new Uint8Array(64).fill(4),
      vaultKey: new Uint8Array(32).fill(5),
    };
    const payload = await publicKeyPayload(identity);

    expect(Object.keys(payload).sort()).toEqual(['key_updated_at', 'public_key', 'signing_key']);
    // The private halves must not appear under any key, in any encoding.
    const serialized = JSON.stringify(payload);
    for (const secret of [identity.boxPrivate, identity.signPrivate, identity.vaultKey]) {
      const b64 = Buffer.from(secret).toString('base64');
      expect(serialized).not.toContain(b64);
    }
  });
});
