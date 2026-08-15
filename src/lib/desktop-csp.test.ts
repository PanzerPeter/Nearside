import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The desktop shell's default Content-Security-Policy forbids WebAssembly, and
// libsodium is WebAssembly, so a packaged build with the default policy derives
// no keys at all: the recovery phrase validates and then the restore dies. It
// cannot be caught by running the app in dev — that policy carries
// 'unsafe-eval' — and it cannot be caught by a type check, because the config
// is valid either way. So it is caught here.
const CONFIG = 'electron/capacitor.electron.config.ts';

/** The directives, with the comments explaining them stripped — this file
 *  documents why 'unsafe-eval' is refused, and prose is not policy. */
function directives(): string {
  return (
    readFileSync(CONFIG, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // Whole comment lines only. A `//` anywhere on a line is not a comment
      // marker — `https://*.supabase.co` is a source expression whose scheme
      // separator would be read as one, and truncating it there turned the
      // host allowance into a bare `https:` that these tests then argued
      // about with themselves.
      .replace(/^\s*\/\/.*$/gm, '')
  );
}

/**
 * One directive's source list.
 *
 * Read off the string literals rather than by splitting on `;`, because the
 * separator is added by `.join('; ')` at runtime and is nowhere in the file:
 * a naive split returns the whole rest of the array as one directive, and an
 * assertion about `img-src` then quietly examines `connect-src` too.
 */
function directive(name: string): string {
  const quoted = [...directives().matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  return quoted.find((d) => d.startsWith(`${name} `)) ?? '';
}

describe('desktop content security policy', () => {
  it('allows WebAssembly, which every derived key goes through', () => {
    if (!existsSync(CONFIG)) return; // checkout without the desktop shell
    expect(directives()).toContain("'wasm-unsafe-eval'");
  });

  it('does not buy that with unsafe-eval', () => {
    if (!existsSync(CONFIG)) return;
    // 'unsafe-eval' also permits WebAssembly and would make the symptom go
    // away. It hands the renderer `eval` and `new Function` back, in an app
    // built on not trusting what the server sends it.
    expect(directives().replace(/'wasm-unsafe-eval'/g, '')).not.toContain("'unsafe-eval'");
  });

  it('lets an avatar load from Supabase storage', () => {
    if (!existsSync(CONFIG)) return;
    // The `avatars` bucket is public and its objects are rendered from their
    // storage URL rather than decrypted into a blob, so the default
    // `img-src 'self' data: blob:` blanks every profile picture on desktop.
    expect(directive('img-src')).toContain('https://*.supabase.co');
  });

  it('keeps the image host list narrower than all of https', () => {
    if (!existsSync(CONFIG)) return;
    // An avatar URL is a database column. A bare `https:` here would let a
    // single tampered row point every client at a host of its choosing.
    expect(directive('img-src').split(/\s+/)).not.toContain('https:');
  });
});
