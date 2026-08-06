import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Every file under a directory, recursively, skipping build and dependency output. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe('branding', () => {
  // The rename is enforced rather than trusted: a stray "chatly" in a theme
  // name or an IndexedDB key is invisible in review and breaks at runtime.
  it('leaves no reference to the old product name', () => {
    const roots = ['src', 'index.html', 'package.json', 'tailwind.config.js', 'vite.config.ts'];
    const files = roots.flatMap((r) => (statSync(r).isDirectory() ? walk(r) : [r]));
    const offenders = files.filter((f) => {
      if (f.endsWith('branding.test.ts')) return false;
      return /chatly/i.test(readFileSync(f, 'utf8'));
    });
    expect(offenders).toEqual([]);
  });
});
