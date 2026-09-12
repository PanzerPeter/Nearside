import { describe, expect, it } from 'vitest';
import { nextMenuIndex, placeMenu, type PlacementInput } from './menu-placement';

const BASE: Omit<PlacementInput, 'anchor'> = {
  width: 160,
  height: 120,
  viewport: { width: 400, height: 800 },
  safe: { top: 24, bottom: 16 },
  gap: 4,
  margin: 8,
};

/** A row near the top of a list, and its `⋯` button at the right edge. */
const topRow = { top: 100, bottom: 156, left: 8, right: 392 };

describe('placeMenu', () => {
  it('hangs the card below its anchor when there is room', () => {
    expect(placeMenu({ ...BASE, anchor: topRow }).top).toBe(160);
  });

  it('right-aligns the card to the anchor', () => {
    // 392 (anchor right) - 160 (width) = 232.
    expect(placeMenu({ ...BASE, anchor: topRow }).left).toBe(232);
  });

  it('flips above the anchor when the card would run off the bottom', () => {
    const low = { top: 700, bottom: 756, left: 8, right: 392 };
    // 700 - 120 - 4 = 576, rather than 760 which would overhang.
    expect(placeMenu({ ...BASE, anchor: low }).top).toBe(576);
  });

  it('keeps the card clear of the gesture pill, not just the viewport edge', () => {
    // 660 + 4 + 120 = 784. That fits the 800px viewport and does NOT fit above
    // the 16px bottom inset, so it has to flip — landing under the pill is
    // landing somewhere untappable.
    const nearBottom = { top: 600, bottom: 660, left: 8, right: 392 };
    expect(placeMenu({ ...BASE, anchor: nearBottom }).top).toBe(600 - 120 - 4);
  });

  it('scrolls rather than overhangs when the card is taller than the screen', () => {
    const short = {
      ...BASE,
      viewport: { width: 400, height: 200 },
      height: 180,
      anchor: { top: 90, bottom: 146, left: 8, right: 392 },
    };
    const pos = placeMenu(short);
    // The available band is 200 - 8 - 16 - 8 - 24 = 144, so the card is capped
    // there and sits flush against the top limit. Clamping a 180px card into a
    // 144px band without capping it is how the last item ends up unreachable.
    expect(pos.maxHeight).toBe(144);
    expect(pos.top).toBe(32);
    expect(pos.top + pos.maxHeight).toBeLessThanOrEqual(200 - 8 - 16);
  });

  it('leaves a card that fits uncapped in practice', () => {
    // 800 - 8 - 16 - 8 - 24 = 744: far more than any row menu needs, so the cap
    // never engages on an ordinary screen.
    expect(placeMenu({ ...BASE, anchor: topRow }).maxHeight).toBe(744);
  });

  it('never lets a wide card spill off the left edge', () => {
    const wide = placeMenu({ ...BASE, width: 500, anchor: topRow });
    expect(wide.left).toBe(8);
  });

  it('left-aligns to the anchor when asked', () => {
    // A message bubble on the left of the thread: a right-aligned card would
    // start where the bubble ends and point away from what it belongs to.
    expect(placeMenu({ ...BASE, anchor: topRow, align: 'start' }).left).toBe(8);
  });

  it('prefers above the anchor when asked, where the thumb is not', () => {
    // 100 - 120 - 4 = -24 would run off the top, so use a row low enough that
    // above genuinely fits: 400 - 120 - 4 = 276.
    const midRow = { top: 400, bottom: 456, left: 8, right: 392 };
    expect(placeMenu({ ...BASE, anchor: midRow, prefer: 'above' }).top).toBe(276);
    // The same anchor without the preference goes below.
    expect(placeMenu({ ...BASE, anchor: midRow }).top).toBe(460);
  });

  it('flips an above-preferring card below when the top has no room', () => {
    // 100 - 120 - 4 = -24, past the 32px top limit, so it has to go under.
    expect(placeMenu({ ...BASE, anchor: topRow, prefer: 'above' }).top).toBe(160);
  });
});

describe('nextMenuIndex', () => {
  it('starts at the first item when nothing is focused', () => {
    expect(nextMenuIndex(-1, 'ArrowDown', 3)).toBe(0);
  });

  it('reaches the last item by arrowing up from nothing', () => {
    expect(nextMenuIndex(-1, 'ArrowUp', 3)).toBe(2);
  });

  it('wraps in both directions', () => {
    expect(nextMenuIndex(2, 'ArrowDown', 3)).toBe(0);
    expect(nextMenuIndex(0, 'ArrowUp', 3)).toBe(2);
  });

  it('jumps to the ends', () => {
    expect(nextMenuIndex(1, 'Home', 3)).toBe(0);
    expect(nextMenuIndex(1, 'End', 3)).toBe(2);
  });

  it('has nowhere to go in an empty menu', () => {
    expect(nextMenuIndex(-1, 'ArrowDown', 0)).toBe(-1);
  });
});
