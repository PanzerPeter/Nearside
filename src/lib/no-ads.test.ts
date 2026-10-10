import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Spec §11: no advertising SDK ships, and that is presented to users as a
// checkable property of the build rather than a promise. A convention would
// not survive the week someone reaches for a quick revenue line.
const AD_SDK =
  /admob|applovin|ironsource|unity-ads|audience-network|adcolony|vungle|google-mobile-ads|play-services-ads/i;

describe('no advertising SDK', () => {
  it('is absent from the whole npm dependency tree', () => {
    // The lockfile, not package.json: an ad SDK arrives as somebody else's
    // dependency far more often than as one of ours.
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    const names = Object.keys(lock.packages ?? {});
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => AD_SDK.test(n))).toEqual([]);
  });

  it('is not declared by the Android build', () => {
    // Only what this repository declares. The resolved Gradle tree is out of
    // a node test's reach, and it is not clean: RevenueCat's SDK depends on
    // `play-services-ads-identifier`, Google's advertising-ID library — not an
    // ad SDK, but the ID ads are built on. The test below is what holds that.
    const gradle = 'android/app/build.gradle';
    if (!existsSync(gradle)) return; // web-only checkout
    expect(AD_SDK.test(readFileSync(gradle, 'utf8'))).toBe(false);
  });

  it('strips the advertising-ID permission from the merged manifest', () => {
    // Without AD_ID the ID reads as zeros on Android 13+, and `tools:node`
    // removes it whichever library tries to merge it in.
    const manifest = 'android/app/src/main/AndroidManifest.xml';
    if (!existsSync(manifest)) return; // web-only checkout
    expect(readFileSync(manifest, 'utf8')).toMatch(
      /<uses-permission\s+android:name="com\.google\.android\.gms\.permission\.AD_ID"\s+tools:node="remove"\s*\/>/
    );
  });
});
