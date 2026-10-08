#!/bin/sh
# Turns a checkout into the F-Droid build: Android without OneSignal,
# or RevenueCat. F-Droid's inclusion policy forbids both, and its scanner fails the build on any trace of them in the Gradle
# files. Run from the repository root after `npm ci`; it rewrites tracked files,
# so on a development machine run it in a throwaway worktree, never in place.
set -eu

# Out of package.json, so `cap sync` stops generating Gradle projects for them.
npm uninstall --no-audit --no-fund \
  @revenuecat/purchases-capacitor \
  onesignal-cordova-plugin

# The Google Gradle plugins only ever ran with google-services.json present,
# which F-Droid never has, but the scanner reads the lines, not the condition.
sed -i -e '/com\.google\.gms:google-services/d' android/build.gradle
sed -i -e '/^try {$/,/^}$/d' android/app/build.gradle

# OneSignal's notification hook, which does not compile without OneSignal. The
# manifest meta-data naming it is left: it is a string nobody reads here.
rm android/app/src/main/java/app/nearside/CallNotificationExtension.java

# `--mode foss` sets __FOSS__ and points the plugins' imports at
# src/foss-stub.ts; .env.foss supplies the public Supabase URL and anon key.
NEARSIDE_NATIVE=1 npx vite build --mode foss
npx cap sync android
