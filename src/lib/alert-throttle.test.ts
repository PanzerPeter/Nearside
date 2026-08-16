import { describe, expect, it } from 'vitest';
import { ALERT_COOLDOWN_MS, noteAlert, shouldAlert } from './alert-throttle';

describe('shouldAlert', () => {
  it('alerts when nothing has alerted yet', () => {
    expect(shouldAlert(null, 1_000)).toBe(true);
  });

  it('stays quiet inside the cooldown', () => {
    expect(shouldAlert(1_000, 1_000 + ALERT_COOLDOWN_MS - 1)).toBe(false);
  });

  it('alerts again once the cooldown is up', () => {
    expect(shouldAlert(1_000, 1_000 + ALERT_COOLDOWN_MS)).toBe(true);
  });

  it('alerts when the anchor is in the future', () => {
    // A clock that went backwards — a wake with a corrected time, or a device
    // whose clock was wrong until NTP answered. Comparing only forwards would
    // leave the anchor unreachable and the conversation silent for good.
    expect(shouldAlert(10_000, 1_000)).toBe(true);
  });
});

describe('noteAlert', () => {
  it('anchors on the last alert, not the last message', () => {
    // The point of the whole thing. A steady stream just inside the cooldown
    // would never alert again if each message reset the anchor, so somebody
    // typing every few seconds would go unheard indefinitely.
    const anchors = new Map<string, number>();
    const heard: number[] = [];
    for (let t = 0; t <= ALERT_COOLDOWN_MS * 2; t += ALERT_COOLDOWN_MS / 3) {
      if (noteAlert(anchors, 'alice', t)) heard.push(t);
    }
    expect(heard).toEqual([0, ALERT_COOLDOWN_MS, ALERT_COOLDOWN_MS * 2]);
  });

  it('gives each sender its own budget', () => {
    // Alice mid-burst must not swallow the first thing Bob says.
    const anchors = new Map<string, number>();
    expect(noteAlert(anchors, 'alice', 0)).toBe(true);
    expect(noteAlert(anchors, 'alice', 1_000)).toBe(false);
    expect(noteAlert(anchors, 'bob', 1_000)).toBe(true);
  });

  it('does not move the anchor on a suppressed message', () => {
    const anchors = new Map<string, number>();
    noteAlert(anchors, 'alice', 0);
    noteAlert(anchors, 'alice', ALERT_COOLDOWN_MS - 1);
    expect(anchors.get('alice')).toBe(0);
  });
});
