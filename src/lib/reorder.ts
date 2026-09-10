// Dragging one tile of a grid to a new place, as arithmetic.
//
// The pointer handling belongs in the component — it needs real rects and a
// real pointer — but every decision it makes is index work, and index work is
// where the off-by-ones live. So the component measures and this decides.

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Move one entry, closing the gap behind it and opening one in front. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) {
    return [...list];
  }
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * Which tile the pointer is over, or null when it is over none of them.
 *
 * Hit-testing against the tiles themselves rather than computing a column from
 * the grid's geometry: the grid wraps, its gaps are CSS, and the last row is
 * ragged, so anything derived from a column count is wrong on the row that
 * matters most. Rects come from the DOM and are already correct.
 */
export function indexAtPoint(rects: readonly Rect[], x: number, y: number): number | null {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i;
  }
  return null;
}

/**
 * How far the pointer has travelled, squared.
 *
 * Squared so the threshold check needs no square root, and compared against a
 * squared threshold by the caller. A threshold at all because a tap wobbles:
 * without one, every tap on a touchscreen starts a drag and no sticker can be
 * sent.
 */
export function movedBeyond(
  start: { x: number; y: number },
  now: { x: number; y: number },
  threshold: number
): boolean {
  const dx = now.x - start.x;
  const dy = now.y - start.y;
  return dx * dx + dy * dy > threshold * threshold;
}

/**
 * The rows whose stored position actually changed.
 *
 * Reordering a hundred stickers moves at most a hundred, and usually two: a
 * drag from the end to the start shifts everything between, but a drag between
 * neighbours shifts a pair. Writing only the difference is what keeps the
 * common case one round trip instead of a hundred.
 */
export function changedPositions<T extends { id: string; sort: number }>(
  ordered: readonly T[]
): { id: string; sort: number }[] {
  const changed: { id: string; sort: number }[] = [];
  ordered.forEach((item, index) => {
    if (item.sort !== index) changed.push({ id: item.id, sort: index });
  });
  return changed;
}

/** The same list with `sort` renumbered to match its order. */
export function renumber<T extends { sort: number }>(ordered: readonly T[]): T[] {
  return ordered.map((item, index) => (item.sort === index ? item : { ...item, sort: index }));
}

/**
 * One drag, as both halves of the answer: the order to show, and the rows to
 * write.
 *
 * The two are computed in this order for a reason that cost a working feature.
 * `changedPositions` finds a row that has moved by comparing its *stored*
 * `sort` against its new index, so it has to see the list before it is
 * renumbered — renumber first and every row already agrees with its own
 * index, the diff is empty, and the drag is never written down. The grid moved
 * under the finger, the round trip never happened, and the old order came back
 * on the next open.
 */
export function planReorder<T extends { id: string; sort: number }>(
  list: readonly T[],
  from: number,
  to: number
): { next: T[]; positions: { id: string; sort: number }[] } {
  const moved = moveItem(list, from, to);
  return { next: renumber(moved), positions: changedPositions(moved) };
}
