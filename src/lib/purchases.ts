// The only revenue line this product can honestly carry.
//
// Cosmetics, sold once, through RevenueCat. No advertising SDK enters the build
// (spec §11, enforced by `no-ads.test.ts`), and nothing functional sits behind a
// purchase: a privacy product that paywalls privacy has sold the thing it
// claims to defend. What is for sale is a theme and a set of chat backgrounds.
//
// Everything here degrades to "owns nothing" off-device. A user with no
// purchases is the common case, not an error path — the store has to render for
// them, and so does the rest of the app.
import { Capacitor } from '@capacitor/core';
import { Purchases, type PurchasesPackage } from '@revenuecat/purchases-capacitor';

export interface Pack {
  /** The RevenueCat entitlement id, and the daisyUI theme name it unlocks. */
  id: string;
  name: string;
  description: string;
  /** daisyUI theme applied to `document.documentElement`. */
  theme: string;
  /** Three swatches for the store card, so a pack can be judged before it is
   *  bought. */
  swatches: [string, string, string];
}

export const PACKS: Pack[] = [
  {
    id: 'pack.midnight',
    name: 'Midnight',
    description: 'Deep blues and a colder accent, for reading in the dark.',
    theme: 'nearside-midnight',
    swatches: ['#0b1020', '#1b2a4a', '#6ea8fe'],
  },
  {
    id: 'pack.paper',
    name: 'Paper',
    description: 'A light, warm theme that reads like a page rather than a screen.',
    theme: 'nearside-paper',
    swatches: ['#f6f2e9', '#e0d8c6', '#8a6d3b'],
  },
  {
    id: 'pack.terminal',
    name: 'Terminal',
    description: 'Green on black, monospaced accents, no apologies.',
    theme: 'nearside-terminal',
    swatches: ['#0a0f0a', '#123018', '#4ade80'],
  },
];

/** The theme applied when no pack is active. Ships with the app and is never
 *  for sale — the free experience is the whole app. */
export const DEFAULT_THEME = 'nearside';

const THEME_KEY = 'nearside-theme';

export function packById(id: string): Pack | undefined {
  return PACKS.find((p) => p.id === id);
}

/**
 * The packs this account owns, read from RevenueCat's active entitlements.
 *
 * Off-device — the browser build — this is always empty, and that is correct
 * rather than a limitation: there is no Play billing to ask.
 */
export async function packsFromEntitlements(): Promise<Set<string>> {
  if (!Capacitor.isNativePlatform()) return new Set();
  try {
    const { customerInfo } = await Purchases.getCustomerInfo();
    const active = customerInfo?.entitlements?.active ?? {};
    return new Set(Object.keys(active));
  } catch {
    // Not configured, offline, or Play unavailable. Owning nothing is the
    // honest answer and keeps the store renderable.
    return new Set();
  }
}

export const ownedPacks = packsFromEntitlements;

let configured = false;

/**
 * Starts RevenueCat and identifies the account.
 *
 * `logIn` rather than passing `appUserID` to `configure`: two accounts on one
 * phone must not share an entitlement set, and the id can change after
 * configure has already run.
 */
export async function initPurchases(userId: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const apiKey = import.meta.env.VITE_REVENUECAT_ANDROID_KEY;
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
  if (!Capacitor.isNativePlatform() || !configured) return;
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
  if (!Capacitor.isNativePlatform()) return offers;

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
  if (!Capacitor.isNativePlatform()) return new Set();
  const { customerInfo } = await Purchases.restorePurchases();
  return new Set(Object.keys(customerInfo?.entitlements?.active ?? {}));
}

/**
 * Applies a theme to the document, the mechanism `index.html` already uses.
 *
 * Applying is separated from owning on purpose: `applyTheme` is called at boot
 * from a stored preference, before any entitlement check has finished, so the
 * app does not flash the default theme at someone who paid for another one.
 * `reconcileTheme` is what walks it back if the entitlement turns out to be
 * gone.
 */
export function applyTheme(theme: string): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Private mode, or a storage quota. The theme still applies for this run.
  }
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
 * A stored theme belonging to a pack the account no longer owns falls back to
 * the default — a refund must not leave the paid-for look in place. A theme
 * that is not a pack at all is the default and is left alone.
 */
export function themeForOwnership(stored: string, owned: ReadonlySet<string>): string {
  const pack = PACKS.find((p) => p.theme === stored);
  if (!pack) return DEFAULT_THEME;
  return owned.has(pack.id) ? stored : DEFAULT_THEME;
}
