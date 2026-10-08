import { describe, expect, it } from 'vitest';
import { deletedRuns, hiddenRuns } from './hidden-runs';

const m = (id: string, user_id: string) => ({ id, user_id });

describe('hiddenRuns', () => {
  it('is empty when nobody is hidden', () => {
    expect(hiddenRuns([m('1', 'a')], new Set()).size).toBe(0);
  });

  it('folds a run into its first message and counts it', () => {
    const runs = hiddenRuns([m('1', 'x'), m('2', 'x'), m('3', 'x')], new Set(['x']));
    expect(runs.get('1')).toEqual({ sender: 'x', count: 3 });
    expect(runs.get('2')).toBeNull();
    expect(runs.get('3')).toBeNull();
  });

  it('starts a new run after somebody else speaks', () => {
    const runs = hiddenRuns(
      [m('1', 'x'), m('2', 'a'), m('3', 'x'), m('4', 'x')],
      new Set(['x'])
    );
    expect(runs.get('1')).toEqual({ sender: 'x', count: 1 });
    expect(runs.has('2')).toBe(false);
    expect(runs.get('3')).toEqual({ sender: 'x', count: 2 });
  });

  it('keeps two hidden people in separate runs', () => {
    const runs = hiddenRuns([m('1', 'x'), m('2', 'y')], new Set(['x', 'y']));
    expect(runs.get('1')).toEqual({ sender: 'x', count: 1 });
    expect(runs.get('2')).toEqual({ sender: 'y', count: 1 });
  });

  it('does not reach across anything drawn between two messages', () => {
    const runs = hiddenRuns(
      [m('1', 'x'), m('2', 'x'), m('3', 'x')],
      new Set(['x']),
      (i) => i === 2
    );
    expect(runs.get('1')).toEqual({ sender: 'x', count: 2 });
    expect(runs.get('3')).toEqual({ sender: 'x', count: 1 });
  });
});

describe('deletedRuns', () => {
  const d = (id: string, deleted = true) => ({ id, deleted_at: deleted ? 'x' : null });

  it('leaves a single deletion as its own bubble', () => {
    expect(deletedRuns([d('1', false), d('2'), d('3', false)]).size).toBe(0);
  });

  it('folds two or more in a row into the first', () => {
    const runs = deletedRuns([d('1'), d('2'), d('3'), d('4', false), d('5'), d('6')]);
    expect(runs.get('1')).toBe(3);
    expect(runs.get('2')).toBeNull();
    expect(runs.get('3')).toBeNull();
    expect(runs.has('4')).toBe(false);
    expect(runs.get('5')).toBe(2);
    expect(runs.get('6')).toBeNull();
  });

  it('never folds across a break, and a one-message remainder stays a bubble', () => {
    const runs = deletedRuns([d('1'), d('2'), d('3')], (i) => i === 2);
    expect(runs.get('1')).toBe(2);
    expect(runs.get('2')).toBeNull();
    expect(runs.has('3')).toBe(false);
  });
});
