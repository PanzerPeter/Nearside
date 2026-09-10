// Getting the emoji panel into memory before somebody taps the button.
//
// The panel is by far the largest thing the app loads that is not the app: its
// own chunk is half a megabyte of code and emoji data, and emoji-mart walks all
// ~1900 entries to build search strings, an alias map and a native-character
// map before it can draw a single row. On the click path that walk *is* the
// delay between pressing the smiley and seeing a picker.
//
// So the load is started off the click path — on an idle callback once a
// conversation is open, and again on the press that is about to become the
// click. Both go through the one promise below, so however many conversations
// are opened it happens once a session.
//
// The imports are dynamic here for the same reason the component is lazy: a
// static one would put the whole panel in the app's first chunk, which is the
// thing this file exists to avoid.

/** The picker component's chunk. `EmojiPopover` hands this to `lazy`, so the
 *  prefetch and the open resolve the same module. */
export const loadEmojiPanel = () => import('../components/EmojiPicker');

let warming: Promise<unknown> | null = null;

/**
 * Fetch the panel and build its index ahead of time. Free to call repeatedly.
 *
 * Calling emoji-mart's `init` here rather than leaving it to the picker is the
 * half that matters: the picker's constructor calls it too, but by then the
 * user is waiting. The second call keeps emoji-mart's own memoised promise and
 * skips everything already built.
 */
export function warmEmojiPanel(): void {
  warming ??= Promise.all([loadEmojiPanel(), import('emoji-mart'), import('@emoji-mart/data')])
    .then(([, { init }, { default: data }]) => init({ data }))
    // A prefetch that fails is not a failure: opening the picker asks again,
    // and that path has a Suspense boundary to wait behind.
    .catch(() => {});
}
