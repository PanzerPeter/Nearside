/** Classes for whatever sits on a list row's right-hand edge — the time, the
 *  unread mark. On a pointer device `SwipeRow` shows its "…" handle over that
 *  same edge on hover and focus, and drawn on top of them it read as a stray
 *  glyph through the timestamp; so they make way for it instead. */
export const HANDLE_ZONE =
  'pointer-fine:group-hover/row:invisible pointer-fine:group-focus-within/row:invisible';
