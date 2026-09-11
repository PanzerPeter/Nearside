/**
 * The desktop shell's entry point.
 *
 * Almost everything is `@capawesome/capacitor-electron`'s: window, scheme,
 * CSP, plugin bridge. What is added here is the part a browser tab does not
 * need and a desktop window is unfinished without — a menu bar, a tray icon,
 * and an unread count on the dock or taskbar.
 *
 * **Nothing here opens an IPC channel to the renderer.** Two things are needed
 * from that direction, and the window already reports both: the unread count
 * arrives through the document title (see `unreadFromTitle`), and menu items
 * act by dispatching the keystroke they stand for. Adding a channel would mean
 * a preload bridge and a message format to keep in step across two builds, for
 * a number that is already on the window's title bar.
 */

import { app, BrowserWindow, Menu, Tray, nativeImage, shell } from 'electron';
import { join } from 'node:path';
import { createCapacitorElectronApp } from '@capawesome/capacitor-electron';

import config from './capacitor.electron.config';

/**
 * The count the web app puts in the document title, e.g. `Nearside (3)`.
 *
 * Zero when there is nothing unread, which is also what an unparseable title
 * gives: a badge is a claim about somebody's messages, and guessing at one is
 * worse than showing none.
 */
function unreadFromTitle(title: string): number {
  const match = /\((\d+)\)\s*$/.exec(title);
  if (!match) return 0;
  const count = Number(match[1]);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * Ask the page to act on a shortcut, by sending it the keystroke.
 *
 * `src/lib/shortcuts.ts` is the one place that decides what a keystroke means,
 * and a menu item that called some other entry point would be a second answer
 * to the same question — free to drift the first time a shortcut changes.
 *
 * `executeJavaScript` rather than `sendInputEvent`: an input event goes through
 * the OS focus chain, so it lands in whatever field has the cursor and a menu
 * click is, by definition, a moment when nothing does.
 */
function sendShortcut(window: BrowserWindow, key: string, alt = false): void {
  const init = JSON.stringify({
    key,
    ctrlKey: !alt,
    metaKey: false,
    altKey: alt,
    bubbles: true,
  });
  void window.webContents.executeJavaScript(
    `window.dispatchEvent(new KeyboardEvent('keydown', ${init}))`
  );
}

function buildMenu(window: BrowserWindow): void {
  const isMac = process.platform === 'darwin';

  const template: Parameters<typeof Menu.buildFromTemplate>[0] = [
    // The app menu macOS puts the application's name in. On Windows and Linux
    // the same items belong under File, which is where the quit lives below.
    ...(isMac
      ? ([{ role: 'appMenu' }] as Parameters<typeof Menu.buildFromTemplate>[0])
      : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    // Not decoration: without an Edit menu, the system's own copy, paste and
    // select-all accelerators are not registered at all in a packaged Electron
    // window, so ⌘/Ctrl+C does nothing in the composer.
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Go',
      submenu: [
        {
          label: 'Find a conversation…',
          accelerator: 'CmdOrCtrl+K',
          click: () => sendShortcut(window, 'k'),
        },
        {
          label: 'Search in this chat…',
          accelerator: 'CmdOrCtrl+F',
          click: () => sendShortcut(window, 'f'),
        },
        { type: 'separator' },
        {
          label: 'Previous chat',
          accelerator: 'Alt+Up',
          click: () => sendShortcut(window, 'ArrowUp', true),
        },
        {
          label: 'Next chat',
          accelerator: 'Alt+Down',
          click: () => sendShortcut(window, 'ArrowDown', true),
        },
        { type: 'separator' },
        {
          label: 'Archive this chat',
          accelerator: 'CmdOrCtrl+E',
          click: () => sendShortcut(window, 'e'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        // Deliberately kept. This app's claim is that it can be checked, and
        // the network tab is where somebody checks that a message body never
        // leaves the machine in the clear.
        { role: 'toggleDevTools' },
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Source code',
          click: () => void shell.openExternal('https://github.com/PanzerPeter/Nearside'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * The tray icon, and the unread count wherever this platform shows one.
 *
 * The tray is a way back to a window that has been closed to it, and nothing
 * more — no message list and no preview. A notification surface that renders
 * message content would be a copy of the plaintext living outside the window
 * for as long as the menu is open, which is not a trade worth making for a
 * shortcut to something already one click away.
 */
function attachTray(window: BrowserWindow): Tray | null {
  const icon = nativeImage.createFromPath(join(__dirname, '..', 'assets', 'icon.png'));
  if (icon.isEmpty()) return null;

  // Resized because a tray takes a small image and several platforms will not
  // scale a large one down — they crop it instead, which on a 512px source is
  // a tray icon showing the middle of the logo.
  const tray = new Tray(icon.resize({ width: 20, height: 20 }));
  tray.setToolTip('Nearside');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Show Nearside',
        click: () => {
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
        },
      },
      { type: 'separator' },
      { role: 'quit' },
    ])
  );
  // The obvious gesture on Windows and Linux; macOS opens the menu instead.
  tray.on('click', () => {
    if (window.isVisible() && !window.isMinimized()) window.hide();
    else {
      window.show();
      window.focus();
    }
  });
  return tray;
}

createCapacitorElectronApp({
  ...config,
  hooks: {
    ...config.hooks,
    onWindowCreated: async (window) => {
      await config.hooks?.onWindowCreated?.(window);
      buildMenu(window);
      const tray = attachTray(window);

      // The window's own title is the channel. The web app appends the unread
      // count to it, so every place that count changes already reports it here
      // with no second path to keep in step.
      window.webContents.on('page-title-updated', (_event, title) => {
        const unread = unreadFromTitle(title);
        // macOS and some Linux docks show a badge; Windows has none, and the
        // call is a no-op there rather than an error.
        if (typeof app.setBadgeCount === 'function') app.setBadgeCount(unread);
        tray?.setToolTip(unread > 0 ? `Nearside — ${unread} unread` : 'Nearside');
      });

      // Without this the tray is destroyed with its last reference and the
      // icon disappears from the bar while the app is still running.
      window.on('closed', () => tray?.destroy());
    },
  },
});
