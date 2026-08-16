import { describe, expect, it } from 'vitest';
import {
  ALERT_IDLE_RESET_MS,
  ALERT_LADDER_MS,
  AlertAnchor,
  clearAlert,
  decideAlert,
  noteAlert,
  requiredGapMs,
} from './alert-throttle';

const [, SECOND_GAP, THIRD_GAP, LATER_GAP] = ALERT_LADDER_MS;

/** An anchor as it would stand after `streak` alerts, the last at `alertedAt`. */
function anchor(alertedAt: number, streak: number): AlertAnchor {
  return { alertedAt, streak };
}

describe('requiredGapMs', () => {
  it('lets the first message through with no wait', () => {
    expect(requiredGapMs(0)).toBe(0);
  });

  it('widens with each unanswered alert and then holds', () => {
    expect(requiredGapMs(1)).toBe(SECOND_GAP);
    expect(requiredGapMs(2)).toBe(THIRD_GAP);
    expect(requiredGapMs(3)).toBe(LATER_GAP);
    expect(requiredGapMs(99)).toBe(LATER_GAP);
  });
});

describe('decideAlert', () => {
  it('alerts when nothing has alerted yet', () => {
    expect(decideAlert(null, 1_000, null)).toEqual({ alerting: true, streak: 1 });
  });

  it('lets the first three of a burst be heard', () => {
    // The complaint the ladder answers: one sound for a whole conversation
    // means a phone in a pocket reports six messages as one, and the flat
    // cooldown spent its next sound half a minute later, when the burst was
    // over. Early repeats are the ones that carry information.
    let state: AlertAnchor | null = null;
    const heard: number[] = [];
    for (let t = 0; t <= 60_000; t += 1_000) {
      const decision = decideAlert(state, t, null);
      if (decision.alerting) {
        heard.push(t);
        state = { alertedAt: t, streak: decision.streak };
      }
    }
    expect(heard.slice(0, 3)).toEqual([0, SECOND_GAP, SECOND_GAP + THIRD_GAP]);
  });

  it('settles to one alert per long gap once the ladder is climbed', () => {
    const settled = anchor(100_000, ALERT_LADDER_MS.length);
    expect(decideAlert(settled, 100_000 + LATER_GAP - 1, null).alerting).toBe(false);
    expect(decideAlert(settled, 100_000 + LATER_GAP, null).alerting).toBe(true);
  });

  it('starts over once they have caught up with what we rang about', () => {
    // The case a cooldown alone cannot see: you read the conversation, put the
    // phone down, and the reply thirty seconds later is a new turn rather than
    // the tail of a burst. Silence there is the failure, not the fix.
    const rung = anchor(10_000, 3);
    expect(decideAlert(rung, 12_000, null).alerting).toBe(false);
    expect(decideAlert(rung, 12_000, 11_000)).toEqual({ alerting: true, streak: 1 });
  });

  it('does not count a read older than the alert as catching up', () => {
    // They read up to a point *before* we rang — the message we rang about is
    // still unseen, so we are mid-burst and the ladder holds.
    const rung = anchor(10_000, 2);
    expect(decideAlert(rung, 12_000, 9_999).alerting).toBe(false);
  });

  it('starts over after a long silence', () => {
    // Both of these ring — the ladder's last rung is long past either way. What
    // the reset buys is the *next* message: after a quiet five minutes the
    // conversation is back at the bottom of the ladder, so a reply five seconds
    // later is heard instead of waiting out another forty.
    const rung = anchor(0, ALERT_LADDER_MS.length);
    expect(decideAlert(rung, ALERT_IDLE_RESET_MS - 1, null)).toEqual({
      alerting: true,
      streak: ALERT_LADDER_MS.length,
    });
    expect(decideAlert(rung, ALERT_IDLE_RESET_MS, null)).toEqual({
      alerting: true,
      streak: 1,
    });
  });

  it('alerts when the anchor is in the future', () => {
    // A clock that went backwards — a wake with a corrected time, or a device
    // whose clock was wrong until NTP answered. Comparing only forwards would
    // leave the anchor unreachable and the conversation silent for good.
    expect(decideAlert(anchor(10_000, 3), 1_000, null)).toEqual({
      alerting: true,
      streak: 1,
    });
  });

  it('keeps the streak bounded', () => {
    // Stored in a column and compared against the ladder's last rung; a number
    // that climbs for as long as a conversation goes unread buys nothing.
    let state = anchor(0, 1);
    for (let i = 0; i < 50; i++) {
      const at = state.alertedAt + LATER_GAP;
      state = { alertedAt: at, streak: decideAlert(state, at, null).streak };
    }
    expect(state.streak).toBe(ALERT_LADDER_MS.length);
  });
});

describe('noteAlert', () => {
  it('anchors on the last alert, not the last message', () => {
    // A steady stream just inside the gap would never alert again if each
    // message reset the anchor, so somebody typing every few seconds would go
    // unheard indefinitely.
    const anchors = new Map<string, AlertAnchor>();
    const heard: number[] = [];
    for (let t = 0; t <= 60_000; t += 2_000) {
      if (noteAlert(anchors, 'alice', t)) heard.push(t);
    }
    expect(heard.slice(0, 3)).toEqual([0, SECOND_GAP + 1_000, 22_000]);
  });

  it('gives each sender its own budget', () => {
    // Alice mid-burst must not swallow the first thing Bob says.
    const anchors = new Map<string, AlertAnchor>();
    expect(noteAlert(anchors, 'alice', 0)).toBe(true);
    expect(noteAlert(anchors, 'alice', 1_000)).toBe(false);
    expect(noteAlert(anchors, 'bob', 1_000)).toBe(true);
  });

  it('does not move the anchor on a suppressed message', () => {
    const anchors = new Map<string, AlertAnchor>();
    noteAlert(anchors, 'alice', 0);
    noteAlert(anchors, 'alice', SECOND_GAP - 1);
    expect(anchors.get('alice')).toEqual({ alertedAt: 0, streak: 1 });
  });

  it('forgets a conversation that has been looked at', () => {
    const anchors = new Map<string, AlertAnchor>();
    noteAlert(anchors, 'alice', 0);
    clearAlert(anchors, 'alice');
    expect(noteAlert(anchors, 'alice', 1_000)).toBe(true);
  });
});
