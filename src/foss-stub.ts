// Stands in for every proprietary plugin in the F-Droid build, where
// scripts/fdroid-prebuild.sh has uninstalled them and vite.config.ts aliases
// their imports here. Only the names have to exist for the bundle to resolve:
// every caller is behind `hasProprietaryPlugins()`, so nothing is ever called.
const absent = {};

export const FirebaseCrashlytics = absent;
export const BarcodeScanner = absent;
export const BarcodeFormat = absent;
export const GoogleBarcodeScannerModuleInstallState = absent;
export const Purchases = absent;
export default absent;
