import { describe, expect, it, vi } from 'vitest';

// Native, so the store paths actually run. Off-device the module short circuits
// to "nothing for sale", which would make every assertion below vacuous.
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'android' },
  SystemBars: { setStyle: async () => undefined },
  SystemBarsStyle: { Light: 'LIGHT', Dark: 'DARK' },
}));

type Pkg = { identifier: string; product: { identifier: string; priceString: string } };

const offerings: { all: Record<string, { availablePackages: Pkg[] } | undefined> } = {
  all: {},
};

let purchaseResult: { entitlements: { active: Record<string, object> } } = {
  entitlements: { active: {} },
};
let purchaseError: unknown = null;

vi.mock('@revenuecat/purchases-capacitor', () => ({
  Purchases: {
    getOfferings: async () => offerings,
    purchasePackage: async () => {
      if (purchaseError) throw purchaseError;
      return { customerInfo: purchaseResult };
    },
  },
}));

import {
  DONATION_TIERS,
  DONATIONS_OFFERING,
  donate,
  donationOffers,
  type DonationOffer,
} from './donations';
import { ALL_PACKS_ENTITLEMENT, PACKS } from './purchases';

function pkg(identifier: string, priceString = '$1.99'): Pkg {
  return { identifier, product: { identifier, priceString } };
}

function reset() {
  offerings.all = {};
  purchaseResult = { entitlements: { active: {} } };
  purchaseError = null;
}

describe('donation tiers', () => {
  it('gives every tier a distinct product id', () => {
    expect(new Set(DONATION_TIERS.map((t) => t.id)).size).toBe(DONATION_TIERS.length);
  });

  it('unlocks the packs on exactly one tier', () => {
    // Two tiers granting the same entitlement means the cheaper one is the only
    // one anybody buys, and the dearer one is a trap.
    expect(DONATION_TIERS.filter((t) => t.unlocksPacks)).toHaveLength(1);
  });

  it('puts the pack-unlocking tier last', () => {
    // The screen renders them in array order, and a bonus attached to anything
    // but the largest amount reads as a mistake.
    expect(DONATION_TIERS[DONATION_TIERS.length - 1].unlocksPacks).toBe(true);
  });

  it('never reuses a theme pack id', () => {
    // A shared id would make `packsFromEntitlements` count a donation as a pack.
    const packIds = new Set(PACKS.map((p) => p.id));
    for (const tier of DONATION_TIERS) expect(packIds.has(tier.id)).toBe(false);
  });

  it('describes every tier', () => {
    for (const tier of DONATION_TIERS) {
      expect(tier.name).toBeTruthy();
      expect(tier.blurb).toBeTruthy();
    }
  });
});

describe('donationOffers', () => {
  it('reads live prices from the donations offering', async () => {
    reset();
    offerings.all[DONATIONS_OFFERING] = {
      availablePackages: [pkg(DONATION_TIERS[0].id, '$2.99')],
    };

    const offers = await donationOffers();

    expect(offers.get(DONATION_TIERS[0].id)?.priceString).toBe('$2.99');
  });

  it('returns nothing when the offering is missing', async () => {
    // A tier with no offering behind it is shown as unavailable rather than at
    // a price we made up.
    reset();

    expect(await donationOffers()).toEqual(new Map());
  });

  it('ignores a package that is not a donation tier', async () => {
    // The theme packs live in their own offering, but a misconfigured dashboard
    // can put anything here, and a stray product must not render as a tier.
    reset();
    offerings.all[DONATIONS_OFFERING] = {
      availablePackages: [pkg(PACKS[0].id), pkg('something.else')],
    };

    expect(await donationOffers()).toEqual(new Map());
  });
});

function offerFor(tierId: string): DonationOffer {
  return {
    tierId,
    priceString: '$1.99',
    rcPackage: pkg(tierId) as unknown as DonationOffer['rcPackage'],
  };
}

describe('donate', () => {
  it('reports a completed one-off donation', async () => {
    reset();

    expect(await donate(offerFor(DONATION_TIERS[0].id))).toBe(true);
  });

  it('treats backing out as a declined donation rather than an error', async () => {
    // Cancelling a payment sheet is an ordinary thing to do, and must not
    // surface as a failure toast.
    reset();
    purchaseError = { userCancelled: true };

    expect(await donate(offerFor(DONATION_TIERS[0].id))).toBe(false);
  });

  it('rethrows a real store failure', async () => {
    reset();
    purchaseError = new Error('billing unavailable');

    await expect(donate(offerFor(DONATION_TIERS[0].id))).rejects.toThrow('billing unavailable');
  });

  it('confirms the top tier by the entitlement it grants', async () => {
    // A consumable is done when the call returns, but the tier that unlocks
    // every pack is only done when RevenueCat says the entitlement is active.
    reset();
    const patron = DONATION_TIERS[DONATION_TIERS.length - 1];

    expect(await donate(offerFor(patron.id))).toBe(false);

    purchaseResult = { entitlements: { active: { [ALL_PACKS_ENTITLEMENT]: {} } } };
    expect(await donate(offerFor(patron.id))).toBe(true);
  });
});
