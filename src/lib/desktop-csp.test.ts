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
      // Line-leading block comments only, for the same reason as below and
      // then some: `https://*.supabase.co` contains `/*`, so an unanchored
      // match opens a comment inside a source expression and swallows every
      // directive up to the next `*/` in the file. That deletion is silent —
      // the assertions simply start reading an empty string and passing or
      // failing about nothing.
      .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
      // Whole comment lines only. A `//` anywhere on a line is not a comment
      // marker — `https://*.supabase.co` is a source expression whose scheme
      // separator would be read as one, and truncating it there turned the
      // host allowance into a bare `https:` that these tests then argued
      // about with themselves.
      .replace(/^\s*\/\/.*$/gm, '')
  );
}

/**
 * The shipped policy's directives, one string each.
 *
 * Read off the string literals rather than by splitting on `;`, because the
 * separator is added by `.join('; ')` at runtime and is nowhere in the file:
 * a naive split returns the whole rest of the array as one directive, and an
 * assertion about `img-src` then quietly examines `connect-src` too.
 *
 * The dev relaxations in the same file are bare source expressions
 * (`'unsafe-eval'`, `ws:`) rather than whole directives, so "starts with a
 * name and a space" separates the two lists without the tests needing to know
 * how the dev policy is assembled.
 */
function policyDirectives(): string[] {
  return [...directives().matchAll(/"([^"]*)"/g)]
    .map((m) => m[1])
    .filter((d) => /^[a-z][a-z-]*\s\S/.test(d));
}

/** One directive's source list. */
function directive(name: string): string {
  return policyDirectives().find((d) => d.startsWith(`${name} `)) ?? '';
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
    //
    // Asserted over the shipped directives rather than the whole file: the dev
    // policy is the shell's, carries 'unsafe-eval' for HMR, and is never in a
    // build anybody installs. What must not happen is that token reaching a
    // directive in this list.
    const shipped = policyDirectives().join('; ').replace(/'wasm-unsafe-eval'/g, '');
    expect(shipped).not.toContain("'unsafe-eval'");
  });

  it('lets a blob: URL be fetched back', () => {
    if (!existsSync(CONFIG)) return;
    // Every decrypted picture in the app lives in a `blob:` URL, and sending a
    // sticker reads one back with `fetch` to rebuild a File (`stickerFile`);
    // saving an attachment does the same (`MediaLightbox`). `connect-src`
    // governs that fetch and `'self'` does not cover `blob:`, so without this
    // the desktop build shows the sticker drawer and then refuses to send from
    // it. The URLs are minted by this renderer from bytes it already holds, so
    // allowing them adds no reachable host.
    expect(directive('connect-src').split(/\s+/)).toContain('blob:');
  });

  it('states each directive once, so the dev policy cannot drift', () => {
    if (!existsSync(CONFIG)) return;
    // The dev policy is derived from the shipped one. Written out a second
    // time it would be a copy that stops matching — which is how `blob:` came
    // to be missing from the shell's own two lists in the first place.
    const names = policyDirectives().map((d) => d.split(' ')[0]);
    expect([...new Set(names)]).toEqual(names);
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
