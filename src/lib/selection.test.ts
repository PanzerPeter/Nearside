import { describe, expect, it } from 'vitest';
import {
  prunedSelection,
  selectionPowers,
  toggleSelected,
  type SelectableMessage,
} from './selection';

function msg(id: string, isOwn = true, forwardable = true): SelectableMessage {
  return { id, isOwn, forwardable };
}

describe('selectionPowers', () => {
  it('offers nothing on an empty selection', () => {
    expect(selectionPowers([])).toEqual({ count: 0, canDelete: false, canForward: false });
  });

  it('allows a delete when every message is your own', () => {
    expect(selectionPowers([msg('a'), msg('b')]).canDelete).toBe(true);
  });

  it('refuses a delete as soon as one message is not yours', () => {
    expect(selectionPowers([msg('a'), msg('b', false)]).canDelete).toBe(false);
  });

  it('allows a forward when every message can be forwarded', () => {
    expect(selectionPowers([msg('a'), msg('b', false)]).canForward).toBe(true);
  });

  it('refuses a forward as soon as one message cannot be', () => {
    // A message that failed its signature check would be re-signed as yours.
    expect(selectionPowers([msg('a'), msg('b', true, false)]).canForward).toBe(false);
  });

  it('counts what is selected', () => {
    expect(selectionPowers([msg('a'), msg('b'), msg('c')]).count).toBe(3);
  });
});

describe('toggleSelected', () => {
  it('adds one that was not selected', () => {
    expect([...toggleSelected(new Set(['a']), 'b')]).toEqual(['a', 'b']);
  });

  it('removes one that was', () => {
    expect([...toggleSelected(new Set(['a', 'b']), 'a')]).toEqual(['b']);
  });

  it('leaves the set it was given alone', () => {
    const before = new Set(['a']);
    toggleSelected(before, 'b');
    expect([...before]).toEqual(['a']);
  });
});

describe('prunedSelection', () => {
  it('drops an id the thread no longer holds', () => {
    expect([...prunedSelection(new Set(['a', 'gone']), [{ id: 'a' }])]).toEqual(['a']);
  });

  it('keeps everything still present', () => {
    expect([...prunedSelection(new Set(['a', 'b']), [{ id: 'a' }, { id: 'b' }])]).toEqual([
      'a',
      'b',
    ]);
  });

  it('empties a selection whose thread went away', () => {
    expect([...prunedSelection(new Set(['a']), [])]).toEqual([]);
  });
});
