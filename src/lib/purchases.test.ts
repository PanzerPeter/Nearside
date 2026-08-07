import { describe, expect, it, vi } from 'vitest';

// Native, so the entitlement path actually runs — off-device the module short
// circuits to "owns nothing", which would make every assertion below vacuous.
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
}));

const customerInfo: { entitlements: { active: Record<string, object> } } = {
  entitlements: { active: { 'pack.midnight': {} } },
};

vi.mock('@revenuecat/purchases-capacitor', () => ({
  Purchases: {
    getCustomerInfo: async () => ({ customerInfo }),
  },
}));

import {
  DEFAULT_THEME,
  PACKS,
  packById,
  packsFromEntitlements,
  themeForOwnership,
} from './purchases';

describe('purchases', () => {
  it('reads owned packs from active entitlements', async () => {
    expect(await packsFromEntitlements()).toEqual(new Set(['pack.midnight']));
  });

  it('treats no entitlements as owning nothing rather than throwing', async () => {
    // A user with no purchases is the common case, and it must not be an error
    // path — the theme store has to render for them.
    const saved = customerInfo.entitlements.active;
    customerInfo.entitlements.active = {};
    expect(await packsFromEntitlements()).toEqual(new Set());
    customerInfo.entitlements.active = saved;
  });
});

describe('packs', () => {
  it('gives every pack a distinct id and theme', () => {
    expect(new Set(PACKS.map((p) => p.id)).size).toBe(PACKS.length);
    expect(new Set(PACKS.map((p) => p.theme)).size).toBe(PACKS.length);
  });

  it('never sells the default theme', () => {
    // The free experience is the whole app. Charging for the look it ships
    // with would be a functional paywall wearing a cosmetic label.
    expect(PACKS.map((p) => p.theme)).not.toContain(DEFAULT_THEME);
  });

  it('gives every pack three swatches so it can be judged before purchase', () => {
    for (const pack of PACKS) {
      expect(pack.swatches).toHaveLength(3);
      for (const swatch of pack.swatches) expect(swatch).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('finds a pack by id and nothing by a made-up one', () => {
    expect(packById(PACKS[0].id)?.name).toBe(PACKS[0].name);
    expect(packById('pack.nonexistent')).toBeUndefined();
  });
});

describe('themeForOwnership', () => {
  it('keeps a theme the account owns', () => {
    const pack = PACKS[0];
    expect(themeForOwnership(pack.theme, new Set([pack.id]))).toBe(pack.theme);
  });

  it('falls back when the entitlement is gone', () => {
    // A refund must not leave the paid-for look in place.
    expect(themeForOwnership(PACKS[0].theme, new Set())).toBe(DEFAULT_THEME);
  });

  it('leaves a non-pack theme as the default', () => {
    expect(themeForOwnership(DEFAULT_THEME, new Set())).toBe(DEFAULT_THEME);
    expect(themeForOwnership('something-else', new Set())).toBe(DEFAULT_THEME);
  });
});
