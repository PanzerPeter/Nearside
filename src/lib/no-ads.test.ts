import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Spec §11: no advertising SDK ships, and that is presented to users as a
// checkable property of the build rather than a promise. A convention would
// not survive the week someone reaches for a quick revenue line.
const AD_SDK =
  /admob|applovin|ironsource|unity-ads|audience-network|adcolony|vungle|google-mobile-ads|play-services-ads/i;

describe('no advertising SDK', () => {
  it('is absent from the npm dependency tree', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    expect(names.filter((n) => AD_SDK.test(n))).toEqual([]);
  });

  it('is absent from the Android build', () => {
    const gradle = 'android/app/build.gradle';
    if (!existsSync(gradle)) return; // web-only checkout
    expect(AD_SDK.test(readFileSync(gradle, 'utf8'))).toBe(false);
  });
});
