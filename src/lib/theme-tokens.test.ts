import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Nine themes, and each one repeats the app's own tokens in full. daisyUI does
// not inherit them from the default theme: a block that omits `--brand-lit`
// renders the *literal string* `var(--brand-lit)` wherever it is used, which is
// invisible to `tsc`, invisible to ESLint, and shows up only as a broken paid
// pack on somebody's phone. Six of these themes are sold.
//
// So the guard is here, in the one place that reads the stylesheet as data.
// Same register as `no-plaintext.test.ts` and `version.test.ts`: it is not
// testing that the colours are nice, it is testing that a pack cannot ship
// half-defined.
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const css = read('src/index.css');

/** Every `@plugin "daisyui/theme"` block in the stylesheet, by theme name. */
function themeBlocks(): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const match of css.matchAll(/@plugin "daisyui\/theme"\s*\{([^}]*)\}/g)) {
    const body = match[1];
    const name = /name:\s*"([^"]+)"/.exec(body)?.[1];
    if (name) blocks.set(name, body);
  }
  return blocks;
}

/** Declared by the app rather than by daisyUI, so nothing else supplies them. */
const APP_TOKENS = [
  '--surface-ring',
  '--receipt-read',
  '--presence-offline',
  '--brand-lit',
  '--brand-dim',
];

/** Shape and finish. `--depth`/`--noise` are pinned to 0 in every theme: left
 *  at daisyUI's default of 1 they mix a gradient and a drop shadow into
 *  buttons, badges, alerts and menus, which is the flat surface system undone
 *  one component at a time. */
const SHAPE_TOKENS = ['--radius-box', '--radius-field', '--radius-selector', '--border'];

describe('theme tokens', () => {
  const blocks = themeBlocks();

  it('finds every theme the stylesheet declares', () => {
    // A parser that silently matched nothing would pass every test below.
    expect(blocks.size).toBeGreaterThanOrEqual(9);
    expect(blocks.has('nearside')).toBe(true);
  });

  it.each([...themeBlocks().keys()])('%s declares every app token', (name) => {
    const body = blocks.get(name)!;
    for (const token of APP_TOKENS) expect(body).toContain(`${token}:`);
  });

  it.each([...themeBlocks().keys()])('%s declares its own shape', (name) => {
    const body = blocks.get(name)!;
    for (const token of SHAPE_TOKENS) expect(body).toContain(`${token}:`);
  });

  it.each([...themeBlocks().keys()])('%s stays flat', (name) => {
    const body = blocks.get(name)!;
    expect(body).toMatch(/--depth:\s*0;/);
    expect(body).toMatch(/--noise:\s*0;/);
  });

  it.each([...themeBlocks().keys()])('%s gives the brand two real tones', (name) => {
    const body = blocks.get(name)!;
    const lit = /--brand-lit:\s*(#[0-9a-fA-F]{6});/.exec(body)?.[1];
    const dim = /--brand-dim:\s*(#[0-9a-fA-F]{6});/.exec(body)?.[1];
    // Literal hex, not a `color-mix` off `--color-primary`: derivation
    // collapses on the packs that were paid for — `graphite`'s primary is
    // near-achromatic, so a computed pair is grey on grey.
    expect(lit).toBeDefined();
    expect(dim).toBeDefined();
    // A gradient whose two stops match is a flat fill wearing a gradient's
    // name, and it would pass every other check here.
    expect(lit).not.toBe(dim);
  });

  it('every theme a pack sells has a block behind it', () => {
    // `applyTheme` stamps whatever the pack names onto <html>. A pack pointing
    // at a theme with no block leaves the previous theme's colours in place,
    // so the purchase appears to do nothing at all.
    const purchases = read('src/lib/purchases.ts');
    const sold = [...purchases.matchAll(/^\s*theme: '([^']+)',/gm)].map((m) => m[1]);
    expect(sold.length).toBeGreaterThan(0);
    for (const theme of sold) expect([...blocks.keys()]).toContain(theme);
  });
});
