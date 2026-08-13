# Appearance: themes, motion, elevation, the mark

## Theme packs

Nine themes ship. Three are free and need no store configuration: `nearside`
(the default), Daylight and Void. The other six are non-consumable purchases
through RevenueCat.

Every theme lives in two places and the two must agree: a daisyUI block in
`tailwind.config.js`, and an entry in `PACKS` or `FREE_THEMES` in
`src/lib/purchases.ts`. A pack's `id` is simultaneously its RevenueCat
entitlement id, its store product id, and what `packOffers()` matches an
offering on. `purchases.test.ts` fails if a listed theme has no block behind it,
or if a block is missing one of the `--surface-ring`, `--receipt-read` or
`--presence-offline` tokens the components read.

### Selling a pack, per store

1. Create a **non-consumable** product (Play calls it a one-time in-app product)
   with the pack id verbatim (`pack.midnight`, `pack.paper`, `pack.terminal`,
   `pack.sunset`, `pack.sakura`, `pack.graphite`) in the Play Console or App
   Store Connect, priced and **activated**. A product left as a draft does not
   appear in an offering.
2. In RevenueCat, attach each product to an **entitlement of the same id** and
   put all six packages in the **current offering**. `packOffers()` reads only
   the current offering, and a pack missing from it renders as "Unavailable"
   rather than at a made-up price.
3. Set `VITE_REVENUECAT_ANDROID_KEY` and `VITE_REVENUECAT_IOS_KEY` in `.env`.
   They are different publishable keys for different store apps and are not
   interchangeable. `initPurchases` picks by platform.

On Play, two things outside this repository gate the whole flow, and both fail
as "Unavailable" rather than as an error:

- **The app must exist on a track.** Play only serves in-app products to a build
  whose package name, version code and signing certificate match something it
  has processed, and internal testing is enough. A locally signed APK sideloaded
  onto a phone gets no offering, no matter how correct the RevenueCat dashboard
  is.
- **RevenueCat needs the Play service-account credentials** to validate a
  purchase server-side. Without them the purchase completes in Play and the
  entitlement never arrives, which reads in-app as paying and getting nothing.

### What a purchase actually does

`purchasePack()` hands the RevenueCat package to Play's billing sheet. On
success the entitlement id, which is the pack id, appears in
`customerInfo.entitlements.active`, `ThemeStore` adds it to the owned set and
applies the theme immediately. Nothing is written to Supabase: ownership is
RevenueCat's record, keyed to the Supabase user id through `Purchases.logIn()`,
so the pack follows the account rather than the phone. Reinstalling, or signing
in on a second device, needs **Restore purchases**; Play requires that button to
exist and a user on a new phone genuinely needs it.

At boot `ownedPacks()` reconciles: a stored theme whose pack is no longer owned
falls back to the default, so a refund does not leave the paid-for look in
place. Free themes are never entitlements and are never walked back.

To test a purchase without paying, add the account as a **license tester** in
the Play Console (Setup → License testing) and install from an internal testing
link. The billing sheet then shows a test card and the purchase runs the whole
real path, entitlement included.

### Unlocking packs without a purchase

Migration `0030_theme_grants.sql` adds `theme_grants`: one row per pack an
account owns without having bought it, for demo phones, store screenshots and
review builds. In the SQL editor, as `postgres`:

```sql
SELECT public.grant_theme_packs('tester@example.com');                    -- all six
SELECT public.grant_theme_packs('tester@example.com', ARRAY['pack.paper']);
SELECT public.revoke_theme_grants('tester@example.com');
```

`src/lib/theme-grants.ts` reads those rows back and merges them with the
entitlements, so a granted pack behaves exactly like a bought one. The client
can only read: `theme_grants` has no INSERT policy and the two functions are
revoked from `authenticated`, because a pack the app can award itself is a pack
nobody needs to buy. Grants also work in the browser build, which is the only
place a showcase account can be driven without a phone.

None of this is load-bearing. With no keys, no offering, no network, or without
`0030` applied, the store lists every pack as unavailable, the free themes still
work, and the rest of the app is untouched.

The preview button beside each theme renders a sample conversation in that theme
without applying it, by setting `data-theme` on that element rather than on
`<html>`. Nothing is stored and there is no state to walk back.

## Motion

Two tiers, chosen by `data-motion` on `<html>` and nothing else. Expressive is
the default; **Reduce motion** in Settings → Appearance stores the choice and
repaints on the spot, because every expressive rule in `src/index.css` is scoped
to `:root[data-motion='expressive']` and the attribute simply being absent
yields the restrained set rather than a half-applied one.

`prefers-reduced-motion` is a third and stricter state: it collapses the
attribute to `reduced`, disables the switch, and is caught again by a media
block in the stylesheet, because a few expressive decorations loop and a
duration override alone would freeze them mid-cycle instead of removing them.
`initMotionPreference()` runs in `main.tsx` before the first render, since a
frame painted before the attribute lands would open in the wrong tier and
visibly switch. It also listens for the OS setting changing mid-session, which
on Android is a quick-settings tile.

## Elevation, and why the Tailwind shadows are banned

`shadow-xl` and `shadow-2xl` do not work on this app's surfaces. `shadow-2xl` is
`0 25px 50px -12px rgb(0 0 0 / 0.25)`; over a near-black scrim that alpha spans
about four of the 256 levels per channel, so each 8-bit step lands as a flat
~25px band with a hard edge, and the three channels cross their thresholds at
different radii, fringing every edge green. The result is a stack of coloured
contour rings around the dialog, not a shadow.

So overlays use `shadow-overlay` / `shadow-modal` / `shadow-sheet`, which resolve
to `--elev-*` variables that change with the surface: a hairline ring and a deep
scrim on dark, the ordinary soft blur on light, where the same alpha has the
levels to spend. `data-surface` on `<html>` is set from the live daisyUI
lightness in `purchases.ts`, the same reading that picks the system-bar icon
contrast, so a pack added later cannot be left out of it.
`lib/elevation.test.ts` fails if a banned shadow class reappears.

## The mark

`BrandMark.tsx` and `public/logo-source.svg` are the same drawing: one disc cut
on the diagonal and slid apart, so the logo is really the gap between the two
halves. Every icon in the repo is rendered from those files: Android mipmaps,
the adaptive foreground in `public/logo-foreground.svg`, the iOS asset
catalogue, the splash screens, the PWA icons and the favicon. A change to the
mark means re-rendering them rather than editing a PNG.
