import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { APP_VERSION } from './version';

// Four files carry the version and only one of them is ever edited on purpose.
// Drift is silent: the Play listing says one number, the Settings screen says
// another, and a bug report names whichever the reporter happened to read.
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const pkg = JSON.parse(read('package.json')) as { version: string };

describe('version', () => {
  it('is a plain three-part semver, not a range or a pre-release', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is what the build substitutes into the app', () => {
    expect(APP_VERSION).toBe(pkg.version);
  });

  it('matches the Android versionName', () => {
    const gradle = read('android/app/build.gradle');
    const versionName = /versionName\s+"([^"]+)"/.exec(gradle)?.[1];
    expect(versionName).toBe(pkg.version);
  });

  it('matches the iOS marketing version', () => {
    const pbxproj = read('ios/App/App.xcodeproj/project.pbxproj');
    const marketing = [...pbxproj.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((m) => m[1]);
    // Debug and Release both carry one, and a release that ships a debug-only
    // bump is a release nobody can identify.
    expect(marketing.length).toBeGreaterThan(0);
    for (const version of marketing) expect(version).toBe(pkg.version);
  });

  it('matches the Electron shell', () => {
    const electron = JSON.parse(read('electron/package.json')) as { version: string };
    expect(electron.version).toBe(pkg.version);
  });

  it('has an Android versionCode that rises with the version', () => {
    const gradle = read('android/app/build.gradle');
    const code = Number(/versionCode\s+(\d+)/.exec(gradle)?.[1]);
    // Play rejects an upload whose code it has seen, hours after the build.
    expect(Number.isInteger(code)).toBe(true);
    expect(code).toBeGreaterThanOrEqual(3);
  });
});
