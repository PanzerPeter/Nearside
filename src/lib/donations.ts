// Voluntary support, sold through RevenueCat alongside the theme packs.
//
// A donation buys nothing that changes the app. That is the point and it is
// also the constraint: the moment a tier gates a feature, `purchases.ts` stops
// being true when it says nothing functional sits behind a payment. The one
// exception runs the other way. The largest tier hands over cosmetics that
// were already for sale, so the bonus is a discount on decoration rather than
// a lock on anything.
//
// Everything degrades to "nothing for sale" off-device, which is the same
// shape `packOffers` has: a tier with no offering behind it renders as
// unavailable rather than at a price we invented.
import { Capacitor } from '@capacitor/core';
import { Purchases, type PurchasesPackage } from '@revenuecat/purchases-capacitor';
import { ALL_PACKS_ENTITLEMENT } from './purchases';

/** The RevenueCat offering the tiers live in. Deliberately not `current`,
 *  which is the theme packs: merging the two would put a donation on the
 *  appearance screen. */
export const DONATIONS_OFFERING = 'donations';

export interface DonationTier {
  /** The RevenueCat product id. */
  id: string;
  name: string;
  blurb: string;
  /** Grants `ALL_PACKS_ENTITLEMENT`, so this tier is a non-consumable and its
   *  success is confirmed by the entitlement rather than by the call
   *  returning. Exactly one tier may set it. */
  unlocksPacks?: boolean;
}

/**
 * Ordered smallest to largest, and rendered in this order.
 *
 * No amounts here. The price string comes from the store in the buyer's own
 * currency, and a number written into the app is wrong for everyone outside
 * the one country it was written for.
 */
export const DONATION_TIERS: DonationTier[] = [
  {
    id: 'donate.tip',
    name: 'Tip',
    blurb: 'A one-off thank you. Nothing changes in the app, which is rather the point.',
  },
  {
    id: 'donate.round',
    name: 'Round of hosting',
    blurb: 'Roughly what the database and the notification service cost for a month.',
  },
  {
    id: 'donate.patron',
    name: 'Patron',
    blurb: 'The largest amount. It also unlocks every theme pack, including any you never bought.',
    unlocksPacks: true,
  },
];

export function donationTierById(id: string): DonationTier | undefined {
  return DONATION_TIERS.find((t) => t.id === id);
}

export interface DonationOffer {
  tierId: string;
  priceString: string;
  rcPackage: PurchasesPackage;
}

/** Live prices from the donations offering, keyed by tier id. */
export async function donationOffers(): Promise<Map<string, DonationOffer>> {
  const offers = new Map<string, DonationOffer>();
  if (!Capacitor.isNativePlatform()) return offers;

  try {
    const { all } = await Purchases.getOfferings();
    for (const pkg of all?.[DONATIONS_OFFERING]?.availablePackages ?? []) {
      const tier = DONATION_TIERS.find(
        (t) => pkg.identifier === t.id || pkg.product.identifier === t.id
      );
      if (tier) {
        offers.set(tier.id, {
          tierId: tier.id,
          priceString: pkg.product.priceString,
          rcPackage: pkg,
        });
      }
    }
  } catch {
    // Offerings unreachable. Every tier renders as unavailable.
  }
  return offers;
}

/** True if the donation completed. A cancellation is false, not an error. */
export async function donate(offer: DonationOffer): Promise<boolean> {
  let customerInfo;
  try {
    ({ customerInfo } = await Purchases.purchasePackage({ aPackage: offer.rcPackage }));
  } catch (err) {
    // Backing out of a payment sheet is an ordinary thing to do, and must not
    // surface as a failure. Anything else is a real store problem and the
    // caller has to hear about it.
    if (err && typeof err === 'object' && 'userCancelled' in err && err.userCancelled) return false;
    throw err;
  }

  // A consumable leaves no trace to check, so the call returning is the whole
  // of the confirmation. The tier that unlocks the packs does leave one, and
  // reporting success without it would show an unlocked store that reverts on
  // the next entitlement read.
  if (donationTierById(offer.tierId)?.unlocksPacks) {
    return Boolean(customerInfo?.entitlements?.active?.[ALL_PACKS_ENTITLEMENT]);
  }
  return true;
}
