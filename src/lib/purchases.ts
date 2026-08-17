// The only revenue line this product can honestly carry.
//
// Cosmetics, sold once, through RevenueCat. No advertising SDK enters the
// build (spec §11, enforced by `no-ads.test.ts`), and nothing functional sits
// behind a purchase: a privacy product that paywalls privacy has sold the
// thing it claims to defend. What is for sale is a theme and a set of chat
// backgrounds.
//
// Everything here degrades to "owns nothing" off-device. Owning no packs is
// the common case rather than an error path, and the store has to render for
// it.
import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { Purchases, type PurchasesPackage } from '@revenuecat/purchases-capacitor';
import { isMobileNative } from './platform';
import type { MessageKey } from './i18n';

/** Anything the appearance screen can list, bought or not. */
export interface ThemeOption {
  /** A proper noun, and the same word in every language. */
  name: string;
  /** A message key, not a sentence: this list is built when the module loads,
   *  before the stored language has been read, so the words are looked up
   *  where the card is drawn. */
  description: MessageKey;
  /** daisyUI theme applied to `document.documentElement`. Must exist in
   *  `tailwind.config.js`, or the attribute resolves to no variables at all
   *  and the app renders unstyled. */
  theme: string;
  /** Three swatches for the store card, so a theme can be judged from the
   *  list without opening the preview. */
  swatches: [string, string, string];
}

export interface Pack extends ThemeOption {
  /** The RevenueCat entitlement id. Also the product id we match offerings on. */
  id: string;
}

/** The theme applied when no pack is active. Ships with the app and is never
 *  for sale — the free experience is the whole app. */
export const DEFAULT_THEME = 'nearside';

/**
 * Themes that cost nothing, ever.
 *
 * Light mode and an OLED black are accessibility and battery, not decoration:
 * charging for a screen someone can read outdoors would be a functional
 * paywall wearing a cosmetic label, which is the one thing this file promises
 * not to do. `themeForOwnership` treats every entry here as always owned.
 */
export const FREE_THEMES: ThemeOption[] = [
  {
    name: 'Nearside',
    description: 'theme.nearside',
    theme: DEFAULT_THEME,
    swatches: ['#1a1b1e', '#2a2c31', '#3b82f6'],
  },
  {
    name: 'Daylight',
    description: 'theme.daylight',
    theme: 'nearside-daylight',
    swatches: ['#ffffff', '#e8ecf3', '#2563eb'],
  },
  {
    name: 'Void',
    description: 'theme.void',
    theme: 'nearside-void',
    swatches: ['#000000', '#1c1d21', '#4c8dff'],
  },
];

export const PACKS: Pack[] = [
  {
    id: 'pack.midnight',
    name: 'Midnight',
    description: 'theme.midnight',
    theme: 'nearside-midnight',
    swatches: ['#0b1020', '#1b2a4a', '#6ea8fe'],
  },
  {
    id: 'pack.paper',
    name: 'Paper',
    description: 'theme.paper',
    theme: 'nearside-paper',
    swatches: ['#f6f2e9', '#e0d8c6', '#8a6d3b'],
  },
  {
    id: 'pack.terminal',
    name: 'Terminal',
    description: 'theme.terminal',
    theme: 'nearside-terminal',
    swatches: ['#0a0f0a', '#123018', '#4ade80'],
  },
  {
    id: 'pack.sunset',
    name: 'Sunset',
    description: 'theme.sunset',
    theme: 'nearside-sunset',
    swatches: ['#170d21', '#3a2450', '#e0563f'],
  },
  {
    id: 'pack.sakura',
    name: 'Sakura',
    description: 'theme.sakura',
    theme: 'nearside-sakura',
    swatches: ['#fffafc', '#f7dde8', '#d6336c'],
  },
  {
    id: 'pack.graphite',
    name: 'Graphite',
    description: 'theme.graphite',
    theme: 'nearside-graphite',
    swatches: ['#0f1113', '#2b2f34', '#b3bac4'],
  },
];

/**
 * The entitlement the largest donation tier grants (`lib/donations.ts`).
 *
 * Held here rather than there because `packsFromEntitlements` is what expands
 * it, and an entitlement id that only the donations module knows about would
 * be a pack unlock that the ownership check never sees.
 */
export const ALL_PACKS_ENTITLEMENT = 'packs.all';

const THEME_KEY = 'nearside-theme';

export function packById(id: string): Pack | undefined {
  return PACKS.find((p) => p.id === id);
}

/**
 * Active entitlement ids, as pack ids.
 *
 * Shared by the ownership read and the restore, which must agree: the
 * appearance screen replaces its owned set with whatever restore returns, so a
 * restore that skipped this would lock every pack for a supporter the moment
 * they tapped the button.
 */
function packsFromActive(active: Record<string, unknown> | undefined): Set<string> {
  const ids = Object.keys(active ?? {});

  // The largest donation tier grants one entitlement rather than six, so it
  // has to be expanded. Left as it is, a supporter sees an id that matches no
  // pack and every pack still locked.
  if (ids.includes(ALL_PACKS_ENTITLEMENT)) return new Set(PACKS.map((p) => p.id));

  // Filtered rather than passed through: an entitlement that is not a pack
  // reaches `themeForOwnership` as a theme name with no daisyUI block behind
  // it, which renders as unstyled HTML rather than as a wrong colour.
  return new Set(ids.filter((id) => PACKS.some((p) => p.id === id)));
}

/**
 * The packs this account owns, read from RevenueCat's active entitlements.
 * Always empty in the browser build, correctly: there is no Play billing to
 * ask.
 */
export async function packsFromEntitlements(): Promise<Set<string>> {
  if (!isMobileNative()) return new Set();
  try {
    const { customerInfo } = await Purchases.getCustomerInfo();
    return packsFromActive(customerInfo?.entitlements?.active);
  } catch {
    // Not configured, offline, or Play unavailable. Owning nothing is the
    // honest answer and keeps the store renderable.
    return new Set();
  }
}

/**
 * Whether the packs are owned by donation rather than bought one at a time.
 *
 * `packsFromEntitlements` expands the entitlement, which makes a supporter
 * indistinguishable from someone who bought all six — so the appearance screen
 * has to ask separately to say where they came from.
 */
export async function hasAllPacksEntitlement(): Promise<boolean> {
  if (!isMobileNative()) return false;
  try {
    const { customerInfo } = await Purchases.getCustomerInfo();
    return Boolean(customerInfo?.entitlements?.active?.[ALL_PACKS_ENTITLEMENT]);
  } catch {
    return false;
  }
}

let configured = false;

/**
 * Starts RevenueCat and identifies the account.
 *
 * `logIn` rather than passing `appUserID` to `configure`: two accounts on one
 * phone must not share an entitlement set, and the id can change after
 * configure has already run.
 */
export async function initPurchases(userId: string): Promise<void> {
  if (!isMobileNative()) return;
  // One key per store, and they are not interchangeable. RevenueCat rejects an
  // App Store receipt presented under a Play key, and the failure surfaces as
  // "owns nothing": every paid-for pack gone, with no error to read.
  const apiKey =
    Capacitor.getPlatform() === 'ios'
      ? import.meta.env.VITE_REVENUECAT_IOS_KEY
      : import.meta.env.VITE_REVENUECAT_ANDROID_KEY;
  if (!apiKey) return;

  try {
    if (!configured) {
      await Purchases.configure({ apiKey });
      configured = true;
    }
    await Purchases.logIn({ appUserID: userId });
  } catch {
    // A store that cannot start must not stop the messenger from starting.
  }
}

export async function logOutPurchases(): Promise<void> {
  if (!isMobileNative() || !configured) return;
  await Purchases.logOut().catch(() => {});
}

export interface PackOffer {
  packId: string;
  priceString: string;
  rcPackage: PurchasesPackage;
}

/** Live prices from the RevenueCat offering, keyed by our pack id. A pack with
 *  no offering is shown as unavailable rather than at a price we made up. */
export async function packOffers(): Promise<Map<string, PackOffer>> {
  const offers = new Map<string, PackOffer>();
  if (!isMobileNative()) return offers;

  try {
    const { current } = await Purchases.getOfferings();
    for (const pkg of current?.availablePackages ?? []) {
      const packId = PACKS.find(
        (p) => pkg.identifier === p.id || pkg.product.identifier === p.id
      )?.id;
      if (packId) {
        offers.set(packId, { packId, priceString: pkg.product.priceString, rcPackage: pkg });
      }
    }
  } catch {
    // Offerings unreachable. The store renders each pack as unavailable.
  }
  return offers;
}

/** True if the purchase completed. A cancellation is false, not an error —
 *  backing out of a purchase is an ordinary thing to do. */
export async function purchasePack(offer: PackOffer): Promise<boolean> {
  const { customerInfo } = await Purchases.purchasePackage({ aPackage: offer.rcPackage });
  return Boolean(customerInfo?.entitlements?.active?.[offer.packId]);
}

/** Play requires this, and a user on a second device needs it. */
export async function restorePurchases(): Promise<Set<string>> {
  if (!isMobileNative()) return new Set();
  const { customerInfo } = await Purchases.restorePurchases();
  return packsFromActive(customerInfo?.entitlements?.active);
}

/**
 * Applies a theme to the document, the mechanism `index.html` already uses.
 *
 * Applying is separate from owning. This runs at boot from a stored preference
 * before any entitlement check finishes, so the app does not flash the default
 * theme at someone who paid for another one; `themeForOwnership` walks it back
 * if the entitlement turns out to be gone.
 */
export function applyTheme(theme: string): void {
  document.documentElement.setAttribute('data-theme', theme);
  syncBrowserChrome();
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Private mode, or a storage quota. The theme still applies for this run.
  }
}

/**
 * Points the browser's address bar and the phone's system bars at the active
 * theme. Both are baked into `index.html` as the default theme's colours, so
 * without this a light pack keeps a near-black address bar above a white app,
 * and — since targetSdk 36 draws the app edge-to-edge under the status bar —
 * white clock and battery icons on top of a cream header.
 *
 * Read from the live daisyUI variables rather than a table, so a theme edit in
 * `tailwind.config.js` cannot drift from it.
 */
function syncBrowserChrome(): void {
  try {
    const root = getComputedStyle(document.documentElement);
    const meta = document.querySelector('meta[name="theme-color"]');
    const canvas = root.getPropertyValue('--b3').trim();
    // daisyUI v4 emits the bare oklch components ("22.23% .006 271"), not a
    // colour — and not HSL, which is what this used to wrap them in. A
    // malformed value is dropped silently, so the tag simply never moved.
    if (meta && canvas) meta.setAttribute('content', `oklch(${canvas})`);

    // The status bar sits over the top bar, which is base-100 — that surface,
    // not the canvas, is what the clock has to stay legible against.
    const surface = root.getPropertyValue('--b1').trim();
    const light = surfaceIsLight(surface);
    syncSystemBars(light);

    // Shadows and the modal scrim are tuned per surface, not per pack: the
    // steep, high-alpha shadow that keeps a dark theme's overlays from banding
    // into coloured contour rings reads as a bruise under a cream card, and
    // the soft wide one is the thing that bands. Same lightness reading as the
    // bars above rather than a list of theme names, so a pack added later
    // cannot be left out of it. See `--elev-*` in src/index.css.
    if (light === null) document.documentElement.removeAttribute('data-surface');
    else document.documentElement.setAttribute('data-surface', light ? 'light' : 'dark');
  } catch {
    // Chrome colour is decoration; never let it take the theme down with it.
  }
}

/**
 * Whether the active surface reads as light, or null when the theme has not
 * resolved yet. The first oklch component is a lightness percentage, which is
 * all either caller needs.
 */
function surfaceIsLight(surface: string): boolean | null {
  if (!surface) return null;
  const lightness = Number.parseFloat(surface);
  return Number.isNaN(lightness) ? null : lightness >= 60;
}

/**
 * Status-bar and gesture-bar icon contrast, from the surface behind them.
 *
 * Capacitor's own default picks a style from the *phone's* dark-mode setting,
 * which is the wrong input: the packs are chosen in-app, so a light pack on a
 * phone in dark mode gets white-on-cream icons.
 */
function syncSystemBars(light: boolean | null): void {
  if (!isMobileNative() || light === null) return;
  void SystemBars.setStyle({
    // Capacitor's naming is by content, not by background: Dark means light
    // icons. A light surface therefore takes Light — dark icons.
    style: light ? SystemBarsStyle.Light : SystemBarsStyle.Dark,
  }).catch(() => {
    // Bar styling is cosmetic, and this runs on every theme change; a rejected
    // call must not take the theme with it.
  });
}

export function storedTheme(): string {
  try {
    return localStorage.getItem(THEME_KEY) ?? DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/**
 * The theme that should be showing, given what is owned.
 *
 * A stored theme whose pack the account no longer owns falls back to the
 * default, so a refund does not leave the paid-for look in place. Free themes
 * are always kept: they were never entitlements, so an empty entitlement set
 * says nothing about them. Anything unrecognised is the default.
 */
export function themeForOwnership(stored: string, owned: ReadonlySet<string>): string {
  if (FREE_THEMES.some((t) => t.theme === stored)) return stored;
  const pack = PACKS.find((p) => p.theme === stored);
  if (!pack) return DEFAULT_THEME;
  return owned.has(pack.id) ? stored : DEFAULT_THEME;
}
