// The parts of a call an Android WebView cannot do for itself, through the
// local `CallNative` plugin in
// android/app/src/main/java/app/nearside/CallNative.java.
//
// A no-op in a browser, like `lib/screen-guard.ts` and for the same reason:
// there is no web equivalent for any of it, and a silent fallback would let a
// browser session look like it has protections the Android build actually has.
//
// Three things live behind this boundary:
//
//   1. A foreground service, so the call survives the screen going off. Without
//      one Android freezes the WebView a few seconds after the phone is
//      pocketed and the call dies mid-sentence.
//   2. Audio routing. Choosing the earpiece over the speaker is an AudioManager
//      call; `getUserMedia` has no say in it.
//   3. The full-screen ring, which is a notification with a full-screen intent
//      and therefore a notification-manager job, not a page one.

import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type { CallKind } from './types';
import { isMobileNative } from '../platform';

/** What a ring notification's buttons, or the lock-screen ring itself, reported
 *  back. `open` means the user tapped the notification body. */
export type NativeCallAction = 'accept' | 'decline' | 'open';

export interface PendingCall {
  callId: string;
  peerId: string;
  action: NativeCallAction;
  /**
   * What the ring said the call was, carried so the answer can open the right
   * capture before the offer that settles it arrives. Absent from a
   * notification posted by an older native layer, where a voice call is the
   * safer guess: priming a camera for a call that turns out to be voice costs
   * a camera nobody asked for.
   */
  kind?: CallKind;
}

interface CallNativePlugin {
  /** Start the foreground service and take audio focus. Carries the initial
   *  routing, because the service is what puts the device in call mode and a
   *  route chosen before that does not survive it. */
  startCall(options: { kind: CallKind; peerName: string; speaker: boolean }): Promise<void>;
  endCall(): Promise<void>;
  setSpeaker(options: { on: boolean }): Promise<void>;
  /** Post the ring notification. Used when the app is already running, so the
   *  lock screen shows the same thing whether or not a push woke it. */
  showIncoming(options: {
    callId: string;
    peerId: string;
    peerName: string;
    kind: CallKind;
  }): Promise<void>;
  /** Take the ring down, and remember that this call is settled: a push that
   *  arrives after the realtime offer was already answered must not raise it
   *  again. */
  dismissIncoming(options: { callId?: string }): Promise<void>;
  /** Android 14 stopped granting USE_FULL_SCREEN_INTENT freely. */
  fullScreenIntentAllowed(): Promise<{ allowed: boolean }>;
  openFullScreenIntentSettings(): Promise<void>;
  /** A call the app was launched or resumed for, consumed exactly once. */
  consumePendingCall(): Promise<{ pending: PendingCall | null }>;
  addListener(
    event: 'callAction',
    handler: (data: PendingCall) => void
  ): Promise<PluginListenerHandle>;
}

const CallNative = registerPlugin<CallNativePlugin>('CallNative');

const native = () => isMobileNative();

/**
 * Every call below swallows its own failure.
 *
 * An install running an older native layer than the web bundle — which is
 * exactly what a live-updated WebView on a not-yet-updated APK is — rejects
 * with "plugin not implemented". None of these are worth failing a call over:
 * a call without a foreground service still works while the screen is on, and
 * one routed to the wrong speaker is still a call.
 */
async function attempt(run: () => Promise<unknown>): Promise<void> {
  if (!native()) return;
  try {
    await run();
  } catch {
    /* older native layer, or the plugin is absent */
  }
}

export async function startNativeCall(
  kind: CallKind,
  peerName: string,
  speaker: boolean
): Promise<void> {
  await attempt(() => CallNative.startCall({ kind, peerName, speaker }));
}

export async function endNativeCall(): Promise<void> {
  await attempt(() => CallNative.endCall());
}

export async function setNativeSpeaker(on: boolean): Promise<void> {
  await attempt(() => CallNative.setSpeaker({ on }));
}

export async function showNativeIncoming(call: {
  callId: string;
  peerId: string;
  peerName: string;
  kind: CallKind;
}): Promise<void> {
  await attempt(() => CallNative.showIncoming(call));
}

export async function dismissNativeIncoming(callId?: string): Promise<void> {
  await attempt(() => CallNative.dismissIncoming({ callId }));
}

/**
 * Whether a ring would actually take over the screen.
 *
 * Android 14 restricted `USE_FULL_SCREEN_INTENT` to apps the Play Store
 * classifies as calling or alarm apps; everything else is downgraded to a
 * heads-up notification until the user grants it by hand. False here is not an
 * error — it is the difference between a phone that rings and one that buzzes,
 * and the settings screen offers the grant rather than assuming it.
 */
export async function fullScreenRingAllowed(): Promise<boolean> {
  if (!native()) return false;
  try {
    return (await CallNative.fullScreenIntentAllowed()).allowed;
  } catch {
    // Below Android 14 the permission does not exist and the plugin says so by
    // resolving true; a rejection here means an older native layer, where the
    // question could not be asked and the answer was always yes.
    return true;
  }
}

export async function openFullScreenRingSettings(): Promise<void> {
  await attempt(() => CallNative.openFullScreenIntentSettings());
}

/** The call the app was opened for, if a ring notification opened it. Consumed
 *  once: a pending call left in place would re-answer on every resume. */
export async function consumePendingCall(): Promise<PendingCall | null> {
  if (!native()) return null;
  try {
    return (await CallNative.consumePendingCall()).pending;
  } catch {
    return null;
  }
}

/** Accept/decline tapped on the notification while the app is running. */
export async function onNativeCallAction(
  handler: (pending: PendingCall) => void
): Promise<PluginListenerHandle | null> {
  if (!native()) return null;
  try {
    return await CallNative.addListener('callAction', handler);
  } catch {
    return null;
  }
}
