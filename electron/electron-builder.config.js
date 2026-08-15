/**
 * Packaging for the desktop build.
 *
 * Two Linux targets, because they answer different questions on an Arch system
 * like CachyOS:
 *
 *   AppImage — one file, no package manager, no root. Runs on any glibc distro
 *   and is what a download link should point at. Updating means replacing the
 *   file, which is why `commands.md` describes it that way.
 *
 *   pacman — a real package, so `pacman -U` owns the files and `pacman -R`
 *   removes them. This is the one to install locally: an AppImage left in
 *   ~/Downloads is not tracked by anything, and two of them are two apps.
 *
 * No auto-update channel is configured, deliberately. Auto-update needs a
 * server the app trusts to hand it executable code, and this app's whole claim
 * is that its server is not trusted with anything. Updating is manual and
 * `commands.md` says how.
 *
 * @type {import('electron-builder').Configuration}
 */
module.exports = {
  appId: 'app.nearside',
  productName: 'Nearside',
  directories: {
    output: 'dist',
    buildResources: 'assets',
  },
  files: [
    'build/**/*',
    'app/**/*',
    'generated/**/*',
    'package.json',
    // Platform runtime + plugins, prepared by `capacitor-electron vendor`.
    { from: 'vendor/node_modules', to: 'node_modules' },
  ],
  linux: {
    target: ['AppImage', 'pacman'],
    // fpm — the tool behind the pacman target — refuses to build without a
    // maintainer, and takes it from `author` in package.json otherwise. The
    // noreply address is the one this repo publishes; see the git history.
    maintainer: 'PanzerPeter <189141215+PanzerPeter@users.noreply.github.com>',
    category: 'Network;InstantMessaging',
    // Ties the running window to this .desktop entry. Electron sets WM_CLASS
    // from productName, and without a matching StartupWMClass the dock shows a
    // second, unnamed Electron icon beside the launcher you started it from.
    // (`desktopName` / `syncDesktopName`, which the builder's own warning
    // suggests, are not accepted by 26.15.3 — this is the option that is.)
    desktop: { entry: { StartupWMClass: 'Nearside' } },
    synopsis: 'End-to-end encrypted messenger',
    description:
      'Nearside is an end-to-end encrypted 1:1 and group messenger. The server stores no message bodies.',
  },
};
