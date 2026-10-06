import { describe, expect, it } from 'vitest';
import { hiddenRuns } from './hidden-runs';

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
