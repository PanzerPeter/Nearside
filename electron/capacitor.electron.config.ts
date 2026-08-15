import { defineConfig } from '@capawesome/capacitor-electron/config';

/**
 * The shell's default policy is this list with a bare `script-src 'self'`, and
 * that one directive locks every account out of the desktop build: libsodium is
 * WebAssembly, `WebAssembly.instantiate` counts as eval under CSP, and every
 * key the app derives goes through it. The failure surfaces at the recovery
 * screen — the phrase validates, because bip39 is plain JavaScript, and then
 * `identityFromSeed` dies. Only the packaged app is affected; the dev policy
 * carries `'unsafe-eval'`, so a `npm run electron:start` session cannot
 * reproduce it.
 *
 * `'wasm-unsafe-eval'` grants exactly WebAssembly compilation and nothing else.
 * `'unsafe-eval'` would also work and must not be used: it re-enables `eval`
 * and `new Function` for the whole renderer, which is a remote-code-execution
 * primitive in an app whose threat model says the server is not trusted.
 *
 * `csp.policy` replaces the default entirely rather than extending it, so the
 * rest of this list is the shell's default reproduced verbatim. Diff it against
 * `DEFAULT_CSP` in @capawesome/capacitor-electron after an upgrade — a
 * directive tightened upstream will not reach us here.
 */
const POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  // `https://*.supabase.co` is the one addition to the shell's default list.
  // The `avatars` bucket is public and its objects are rendered straight from
  // their storage URL — every other picture in the app arrives as ciphertext
  // over fetch and is painted from a `blob:`, which is why nothing else needed
  // this. Without it the desktop build shows no profile picture anywhere and
  // no error either: a CSP-blocked <img> fires `error` like a 404, so the app
  // reports a broken avatar for a file that is sitting there.
  //
  // A wildcard rather than the project's own host: this repository is public,
  // and the project ref is not in it. `https:` would also work and is wider
  // than it needs to be — an avatar URL comes out of the database, so the
  // narrower the set of hosts an image may be fetched from, the smaller the
  // pixel-tracker a compromised row could plant.
  "img-src 'self' data: blob: https://*.supabase.co",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self' https: wss:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export default defineConfig({
  window: {
    width: 1200,
    height: 800,
  },
  csp: {
    policy: POLICY,
  },
});
