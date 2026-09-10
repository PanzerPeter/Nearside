// The half of the translation problem `i18n.test.ts` cannot see.
//
// That suite proves every catalog answers every key. It says nothing about a
// sentence that never became a key at all — text typed straight into JSX, which
// is invisible to a catalog check and shows up in English no matter which
// language the phone is in. That is how `RoomView` came to be four blocks of
// untranslated prose while passing a green i18n suite, and how "Replying to"
// sat at the top of the composer in every language.
//
// So this reads the components as text and fails on English left in them.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['src/components', 'src/hooks'];

/**
 * Files whose English is deliberate.
 *
 * The legal documents are the contract and the privacy policy. A machine
 * translation of either is a different contract, and shipping four of those is
 * worse than shipping one document everybody can be pointed at — so they are
 * written once, in English, and the language picker does not touch them.
 */
const ENGLISH_ON_PURPOSE = [
  'LegalPrivacy.tsx',
  'LegalTerms.tsx',
  'LegalFooter.tsx',
  'OpenSourceLicenses.tsx',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.tsx') && !ENGLISH_ON_PURPOSE.includes(entry) ? [path] : [];
  });
}

/** Comments hold the explanations this codebase runs on, and they are prose by
 *  design. Stripped before the scan so a paragraph about why a fix exists is
 *  not reported as a string somebody forgot. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Two or more words, the first capitalised, with no interpolation in them —
 * what a sentence typed into the tree looks like. One capitalised word is
 * usually a name, a unit or a bare glyph and is left alone; the point is to
 * catch prose, not to police every character between two tags.
 */
const SHAPE = /^[A-Z][a-z’']*(?:\s+[\w’'(),.:;!?—–-]+){1,}$/;

/**
 * A sentence needs a word that is not a proper noun.
 *
 * "Supabase Pro." and "Cloudflare Turn" are product names, and a catalog entry
 * for one would invite somebody to translate a thing that has no translation.
 * Every actual sentence carries at least one ordinary lowercase word, so that
 * is the line: capitals all the way through is a name, anything else is prose.
 */
function isSentence(text: string): boolean {
  if (!SHAPE.test(text)) return false;
  return text.split(/\s+/).some((word) => /^[a-z]/.test(word));
}

function jsxText(source: string): string[] {
  // Newlines collapsed first: the blocks that started this were three lines of
  // prose between one pair of tags, and a line-by-line scan saw only fragments.
  const flat = stripComments(source).replace(/\s+/g, ' ');
  const found: string[] = [];
  for (const [, text] of flat.matchAll(/>([^<>{}]+)</g)) {
    const trimmed = text.trim();
    if (isSentence(trimmed)) found.push(trimmed);
  }
  return found;
}

/** The props that carry text a person reads, as opposed to the many that carry
 *  identifiers, paths and class names. */
const TEXT_PROPS = /\b(?:placeholder|title|aria-label|alt|label)="([^"]+)"/g;

function textProps(source: string): string[] {
  const found: string[] = [];
  for (const [, value] of stripComments(source).matchAll(TEXT_PROPS)) {
    const trimmed = value.trim();
    if (isSentence(trimmed)) found.push(trimmed);
  }
  return found;
}

describe('user-visible text goes through the catalogs', () => {
  const files = ROOTS.flatMap(sourceFiles);

  it('finds components to check at all', () => {
    // A path typo here would turn every assertion below into a vacuous pass.
    expect(files.length).toBeGreaterThan(40);
  });

  it('has no English sentence typed into the tree', () => {
    const offenders = files.flatMap((file) =>
      jsxText(readFileSync(file, 'utf8')).map((text) => `${file}: ${text}`)
    );
    expect(offenders).toEqual([]);
  });

  it('has no English sentence in a prop a person reads', () => {
    const offenders = files.flatMap((file) =>
      textProps(readFileSync(file, 'utf8')).map((text) => `${file}: ${text}`)
    );
    expect(offenders).toEqual([]);
  });
});
