import { describe, expect, it } from 'vitest';
import { changedPositions, indexAtPoint, moveItem, movedBeyond, renumber } from './reorder';

describe('moveItem', () => {
  it('moves an entry forwards', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an entry backwards', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('is a copy, not a mutation', () => {
    const original = ['a', 'b', 'c'];
    expect(moveItem(original, 0, 1)).not.toBe(original);
    expect(original).toEqual(['a', 'b', 'c']);
  });

  it('leaves the list alone when nothing moves', () => {
    expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });

  it('refuses an index that is not in the list', () => {
    // A drag released outside the grid reports no target; the caller passes
    // what it has, and a splice at -1 would silently move the item to the end.
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });
});

describe('indexAtPoint', () => {
  const rects = [
    { left: 0, top: 0, right: 10, bottom: 10 },
    { left: 20, top: 0, right: 30, bottom: 10 },
    { left: 0, top: 20, right: 10, bottom: 30 },
  ];

  it('finds the tile under the pointer', () => {
    expect(indexAtPoint(rects, 5, 5)).toBe(0);
    expect(indexAtPoint(rects, 25, 5)).toBe(1);
    expect(indexAtPoint(rects, 5, 25)).toBe(2);
  });

  it('counts the edges as inside, so a drag along a seam still lands', () => {
    expect(indexAtPoint(rects, 10, 10)).toBe(0);
  });

  it('returns null in the gaps and outside the grid', () => {
    expect(indexAtPoint(rects, 15, 5)).toBeNull();
    expect(indexAtPoint(rects, 100, 100)).toBeNull();
  });
});

describe('movedBeyond', () => {
  it('is false for the wobble of a tap', () => {
    expect(movedBeyond({ x: 0, y: 0 }, { x: 3, y: 2 }, 6)).toBe(false);
  });

  it('is true once the pointer has really travelled', () => {
    expect(movedBeyond({ x: 0, y: 0 }, { x: 10, y: 0 }, 6)).toBe(true);
  });

  it('measures diagonally, not per axis', () => {
    // 5 across and 5 down is 7.07 of travel: a per-axis check would call this
    // a tap and a drag away from a tile would do nothing.
    expect(movedBeyond({ x: 0, y: 0 }, { x: 5, y: 5 }, 6)).toBe(true);
  });
});

describe('changedPositions', () => {
  it('reports only the rows whose position moved', () => {
    const ordered = [
      { id: 'a', sort: 1 },
      { id: 'b', sort: 0 },
      { id: 'c', sort: 2 },
    ];
    // 'c' is already at index 2, so it is not written.
    expect(changedPositions(ordered)).toEqual([
      { id: 'a', sort: 0 },
      { id: 'b', sort: 1 },
    ]);
  });

  it('writes nothing when the order is already the stored one', () => {
    expect(changedPositions([{ id: 'a', sort: 0 }, { id: 'b', sort: 1 }])).toEqual([]);
  });
});

describe('renumber', () => {
  it('makes sort agree with position', () => {
    expect(renumber([{ sort: 7 }, { sort: 3 }])).toEqual([{ sort: 0 }, { sort: 1 }]);
  });

  it('keeps the identity of rows that did not move', () => {
    // Referential equality matters: these become React keys' worth of state,
    // and replacing an unchanged object churns every tile's memo.
    const rows = [{ sort: 0 }, { sort: 9 }];
    const out = renumber(rows);
    expect(out[0]).toBe(rows[0]);
    expect(out[1]).not.toBe(rows[1]);
  });
});
