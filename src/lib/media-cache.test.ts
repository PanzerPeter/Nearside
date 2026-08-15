import { describe, expect, it } from 'vitest';
import { selectEvictions, type CacheEntry } from './media-cache';

const entry = (path: string, bytes: number): CacheEntry => ({ path, bytes });

describe('selectEvictions', () => {
  it('evicts nothing while the incoming object still fits', () => {
    expect(selectEvictions([entry('a', 10), entry('b', 10)], 10, 100)).toEqual([]);
  });

  it('evicts least-recently-used first, and only as far as it has to', () => {
    // Oldest use first, which is the order the cache keeps its entries in.
    const held = [entry('a', 40), entry('b', 40), entry('c', 40)];
    expect(selectEvictions(held, 40, 100)).toEqual(['a', 'b']);
  });

  it('stops as soon as the incoming object fits rather than emptying the cache', () => {
    const held = [entry('a', 60), entry('b', 20), entry('c', 20)];
    expect(selectEvictions(held, 10, 100)).toEqual(['a']);
  });

  it('clears everything for an object larger than the whole cap', () => {
    // The caller caches it anyway: refusing would be right on memory and wrong
    // for the user, whose next scroll re-downloads it.
    const held = [entry('a', 30), entry('b', 30)];
    expect(selectEvictions(held, 500, 100)).toEqual(['a', 'b']);
  });

  it('evicts nothing when the cache is empty', () => {
    expect(selectEvictions([], 500, 100)).toEqual([]);
  });

  it('treats a cache exactly at the cap as full', () => {
    expect(selectEvictions([entry('a', 100)], 1, 100)).toEqual(['a']);
  });
});
