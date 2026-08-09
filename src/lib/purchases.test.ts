import { describe, expect, it, vi } from 'vitest';

// Native, so the entitlement path actually runs — off-device the module short
// circuits to "owns nothing", which would make every assertion below vacuous.
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  SystemBars: { setStyle: async () => undefined },
  SystemBarsStyle: { Light: 'LIGHT', Dark: 'DARK' },
}));

const customerInfo: { entitlements: { active: Record<string, object> } } = {
  entitlements: { active: { 'pack.midnight': {} } },
};

vi.mock('@revenuecat/purchases-capacitor', () => ({
  Purchases: {
    getCustomerInfo: async () => ({ customerInfo }),
  },
}));

import { readFileSync } from 'node:fs';
import {
  DEFAULT_THEME,
  FREE_THEMES,
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

describe('free themes', () => {
  it('never overlaps a pack', () => {
    // A theme in both lists is either given away for free or charged for
    // twice, depending on which list the screen reads first.
    const sold = new Set(PACKS.map((p) => p.theme));
    for (const free of FREE_THEMES) expect(sold.has(free.theme)).toBe(false);
  });

  it('includes the shipped default, and describes every entry like a pack', () => {
    expect(FREE_THEMES.map((t) => t.theme)).toContain(DEFAULT_THEME);
    for (const theme of FREE_THEMES) {
      expect(theme.name).toBeTruthy();
      expect(theme.description).toBeTruthy();
      expect(theme.swatches).toHaveLength(3);
      for (const swatch of theme.swatches) expect(swatch).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('every listed theme exists', () => {
  // A theme name with no daisyUI block behind it does not fall back to the
  // default: `data-theme` resolves to no custom properties at all and the app
  // renders as unstyled HTML. A typo here is a white screen, not a wrong colour.
  const config = readFileSync('tailwind.config.js', 'utf8');

  for (const { name, theme } of [...FREE_THEMES, ...PACKS]) {
    it(`defines ${name} (${theme}) in tailwind.config.js`, () => {
      expect(config).toMatch(new RegExp(`['"]?${theme}['"]?\\s*:\\s*\\{`));
    });
  }

  it('gives every theme the status tokens the components read', () => {
    // These are not inherited from the default theme — a block that omits one
    // renders the literal string `var(--receipt-read)` as a colour, which
    // computes to nothing and leaves the glyph invisible.
    for (const token of ['--surface-ring', '--receipt-read', '--presence-offline']) {
      const declared = config.match(new RegExp(`'${token}'`, 'g')) ?? [];
      expect(declared.length).toBe(FREE_THEMES.length + PACKS.length);
    }
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

  it('keeps a free theme with no entitlements at all', () => {
    // Free themes were never entitlements, so an empty set says nothing about
    // them. Reverting someone's light mode on every cold start because
    // RevenueCat had nothing to report is the bug this guards.
    for (const free of FREE_THEMES) {
      expect(themeForOwnership(free.theme, new Set())).toBe(free.theme);
    }
  });
});
