import { describe, expect, it } from 'vitest';
import { blockStatus, blockedByMe, blockedPeers, type BlockRow } from './blocks';

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const PEER = 'bbbbbbbb-0000-4000-8000-000000000002';
const OTHER = 'cccccccc-0000-4000-8000-000000000003';

const mine: BlockRow = { blocker_id: ME, blocked_id: PEER };
const theirs: BlockRow = { blocker_id: PEER, blocked_id: ME };

describe('blockStatus', () => {
  it('reads each direction on its own', () => {
    expect(blockStatus([], ME, PEER)).toBe('none');
    expect(blockStatus([mine], ME, PEER)).toBe('byMe');
    expect(blockStatus([theirs], ME, PEER)).toBe('byThem');
    expect(blockStatus([mine, theirs], ME, PEER)).toBe('both');
  });

  // The case the feature has to get right. Both blocked; I unblock (my row
  // goes); their row still stands, so the conversation must stay shut.
  it('stays blocked when one side of a mutual block unblocks', () => {
    const afterIUnblock = [mine, theirs].filter((r) => r !== mine);
    expect(blockStatus(afterIUnblock, ME, PEER)).toBe('byThem');
    const afterTheyUnblock = [mine, theirs].filter((r) => r !== theirs);
    expect(blockStatus(afterTheyUnblock, ME, PEER)).toBe('byMe');
  });

  it('ignores blocks between other people', () => {
    expect(blockStatus([{ blocker_id: PEER, blocked_id: OTHER }], ME, PEER)).toBe('none');
  });
});

describe('blockedPeers', () => {
  it('collects the other side of every block, in either direction', () => {
    const peers = blockedPeers([mine, { blocker_id: OTHER, blocked_id: ME }], ME);
    expect([...peers].sort()).toEqual([PEER, OTHER].sort());
  });
});

describe('blockedByMe', () => {
  it('lists only the blocks this account placed', () => {
    expect(blockedByMe([mine, { blocker_id: OTHER, blocked_id: ME }], ME)).toEqual([PEER]);
  });
});
