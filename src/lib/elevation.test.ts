import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Overlay elevation, and why Tailwind's big shadows are banned here.
 *
 * `shadow-2xl` is `0 25px 50px -12px rgb(0 0 0 / 0.25)`. Over a white page
 * that alpha spans about 64 of the 256 levels per channel and reads as a
 * smooth blur. Over this app's near-black scrim it spans four — so each 8-bit
 * step lands as a ~25px flat band with a hard edge, and because red, green and
 * blue cross their thresholds at different radii, every band edge is fringed
 * green. What you see is not a shadow but a stack of coloured contour rings
 * around the dialog. `shadow-xl` (0.1 alpha) is worse: two levels total.
 *
 * Shortening the blur shrinks the rings but never removes them, so `--elev-*`
 * in index.css drop the gradient entirely on a dark surface — a 1px ring, the
 * hairline border, and a deep scrim — and keep the soft blur only on light
 * ones, where the same alpha has all those levels to spend.
 */
const SRC = new URL('..', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|css)$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('overlay elevation', () => {
  const files = sourceFiles(SRC);

  it('finds source to check', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  // Markup only. index.css names both of them, in the note explaining the ban.
  const markup = files.filter((path) => path.endsWith('.tsx'));

  for (const utility of ['shadow-2xl', 'shadow-xl']) {
    it(`never uses ${utility}`, () => {
      const offenders = markup.filter((path) => readFileSync(path, 'utf8').includes(utility));
      expect(offenders).toEqual([]);
    });
  }

  const css = readFileSync(join(SRC, 'index.css'), 'utf8');

  it('defines an elevation token per overlay kind', () => {
    for (const token of ['--elev-overlay', '--elev-modal', '--elev-sheet', '--scrim']) {
      expect(css).toContain(`${token}:`);
    }
  });

  it('gives light surfaces their own set', () => {
    // A steep, high-alpha shadow is what stops the banding on a dark theme and
    // is far too heavy on a cream one — where the wide soft version never
    // banded in the first place. Both sets have to exist, keyed off the
    // `data-surface` attribute purchases.ts stamps from the live theme.
    const light = css.slice(css.indexOf("[data-surface='light']"));
    expect(light).toContain('--elev-modal:');
    expect(light).toContain('--scrim:');
  });
});
