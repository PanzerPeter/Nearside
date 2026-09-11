// The window title, which on the desktop is also how the shell learns the
// unread count.
//
// `electron/main.ts` parses this string back into a number to put a badge on
// the dock and a tooltip on the tray. That makes the format a contract between
// two builds that share no code — the shell has its own tsconfig and its own
// `node_modules`, and cannot import this file — so `app-title.test.ts` reads
// the shell's source and proves its parser still understands what this writes.
//
// The alternative was an IPC channel and a preload bridge to carry one integer
// across, which is more moving parts to keep in step than a title bar.

/** The product name on its own, with nothing unread. */
export const APP_TITLE = 'Nearside';

export function appTitle(unread: number): string {
  return unread > 0 ? `${APP_TITLE} (${unread})` : APP_TITLE;
}
