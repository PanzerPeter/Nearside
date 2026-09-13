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
 * The same idea for a run that does not start the sentence.
 *
 * A paragraph broken by a `{name}` leaves English on both sides of the
 * interpolation, and the half after it starts lowercase — which `SHAPE` reads
 * as "not a sentence". That is how the whole of the account-switcher's forget
 * warning sat untranslated while this suite was green: every one of its lines
 * either began with `{` or ended with it.
 *
 * Two ordinary lowercase words is the bar. It is deliberately lower than
 * `SHAPE`'s, so the two filters below carry the weight instead.
 */
function isContinuation(text: string): boolean {
  const words = text.split(/\s+/);
  if (words.length < 2 || !/^[A-Za-z]/.test(text)) return false;
  if (!words.every((word) => /^[\w’'(),.:;!?—–-]+$/.test(word))) return false;
  return words.filter((word) => /^[a-z]/.test(word)).length >= 2;
}

/**
 * What tells a run of JSX text from a run of TypeScript.
 *
 * Widening the scan to `}…{` means it also meets ordinary code — a generic
 * between two angle brackets, the body of an arrow function, the fields of an
 * interface. None of those are prose and all of them are full of characters
 * prose does not contain, so the discriminator is the punctuation rather than
 * a parser this file has no business owning. A spaced ASCII hyphen counts as
 * code — `now - at` is arithmetic, and the prose here uses an em dash.
 */
const CODE_PUNCTUATION = /[=()[\]'"`*/\\|&!<>@#$%^~+]|\.\w|\s-\s/;

/** Words that only ever appear in code, for the runs punctuation alone misses
 *  (`interface Props extends` has none of the characters above). */
const CODE_WORDS =
  /\b(?:interface|extends|export|class|function|const|let|return|import|typeof|readonly|async|await|void|number|boolean|string|null|undefined|never|unknown|any|Promise)\b/;

/**
 * Names that are not words, so not translatable.
 *
 * `SINGLE_WORD` below is what catches a bare "Cancel" or "Zoom" on a button —
 * the class `SHAPE` was built to skip, and the class that had four buttons
 * reading English in every language. The cost of catching it is that the two
 * genuine proper nouns in the tree have to be named here.
 */
const NOT_A_WORD = new Set(['Nearside', 'Alex']);

/** One capitalised word on its own: a button label, most of the time. */
const SINGLE_WORD = /^[A-Z][a-z’']{2,}$/;

function isBareLabel(text: string): boolean {
  return SINGLE_WORD.test(text) && !NOT_A_WORD.has(text);
}

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
  // `}` and `{` are boundaries as much as `>` and `<`: prose sitting beside an
  // interpolated name is still prose, and used not to be looked at.
  for (const [, text] of flat.matchAll(/[>}]([^<>{}]+)[<{]/g)) {
    const trimmed = text.trim();
    if (CODE_PUNCTUATION.test(trimmed) || CODE_WORDS.test(trimmed)) continue;
    if (isSentence(trimmed) || isContinuation(trimmed) || isBareLabel(trimmed)) {
      found.push(trimmed);
    }
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
    if (isSentence(trimmed) || isBareLabel(trimmed)) found.push(trimmed);
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

  it('sees prose broken by an interpolation', () => {
    // What widened the scan. Neither half of this sentence is bounded by a
    // pair of tags, so a `>…<` rule reported nothing at all.
    const source = '<p>Removes {name} from this device, along with its lock.</p>';
    expect(jsxText(source)).toContain('from this device, along with its lock.');
  });

  it('sees a bare label on a button', () => {
    expect(jsxText('<button>Cancel</button>')).toEqual(['Cancel']);
  });

  it('does not report ordinary code as prose', () => {
    expect(jsxText('function place() { const next = now - at; }')).toEqual([]);
  });

  it('has no English sentence in a prop a person reads', () => {
    const offenders = files.flatMap((file) =>
      textProps(readFileSync(file, 'utf8')).map((text) => `${file}: ${text}`)
    );
    expect(offenders).toEqual([]);
  });
});
