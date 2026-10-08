// Getting the emoji panel into memory before somebody taps the button.
//
// The panel is the largest thing the app loads that is not the app: its chunk
// carries the whole emoji table, ~400 kB of names and keywords. Fetching and
// parsing that on the click path *is* the delay between pressing the smiley and
// seeing a picker.
//
// So the load is started off the click path — on an idle callback once a
// conversation is open, and again on the press that is about to become the
// click. Both go through the one promise below, so however many conversations
// are opened it happens once a session.
//
// The import is dynamic here for the same reason the component is lazy: a
// static one would put the whole table in the app's first chunk, which is the
// thing this file exists to avoid.

/** The picker component's chunk. `EmojiPopover` hands this to `lazy`, so the
 *  prefetch and the open resolve the same module. */
export const loadEmojiPanel = () => import('../components/EmojiPicker');

let warming: Promise<unknown> | null = null;

/** Fetch the panel ahead of time. Free to call repeatedly. */
export function warmEmojiPanel(): void {
  // A prefetch that fails is not a failure: opening the picker asks again, and
  // that path has a Suspense boundary to wait behind.
  warming ??= loadEmojiPanel().catch(() => {});
}
