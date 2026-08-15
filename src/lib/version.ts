// The running build's version, substituted at build time from package.json
// (see the `define` in vite.config.ts). Read it from here rather than importing
// package.json into the bundle, which would ship the dependency list with it.
//
// Bug reports name a version, so the string the user can read in Settings has
// to be the one that was actually built — not a constant somebody forgot to
// bump.
export const APP_VERSION: string = __APP_VERSION__;
