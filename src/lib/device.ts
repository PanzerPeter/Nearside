/**
 * Input-capability probes. Both are asked about the *device*, not the browser
 * brand: a Chromebook with a touchscreen and an Android phone want different
 * answers than a user-agent string would give.
 */

/**
 * Whether `<input capture>` will hand off to a camera app. Desktop browsers
 * parse the attribute and then ignore it — the picker opens on the filesystem
 * as usual — so a "Take photo" entry there is a lie. Requiring a coarse
 * pointer keeps the camera entries on the devices that actually have a camera
 * wired to the file picker.
 */
export function supportsCameraCapture(): boolean {
  if (typeof window === 'undefined' || typeof HTMLInputElement === 'undefined') return false;
  if (!('capture' in HTMLInputElement.prototype)) return false;
  return window.matchMedia?.('(pointer: coarse)').matches ?? false;
}

/**
 * True on touch-first devices, where the mic button records for as long as it
 * is held. With a mouse, holding a button down while speaking is awkward, so
 * there the same button toggles instead.
 */
export function isCoarsePointer(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(pointer: coarse)').matches ?? false;
}
