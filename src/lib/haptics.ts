// Touch feedback, kept behind one module so the whole app agrees on when a
// phone should buzz and how hard.
//
// Two rules. It only fires for something the user *did* — sending, or a
// verification landing — never for something that arrived, because a messenger
// that vibrates on every incoming message is a messenger people turn off. And
// it is silent wherever haptics do not exist, which is every browser this ever
// runs in.
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { prefersReducedMotion } from './motion';

/**
 * Reduced motion covers this too.
 *
 * Android exposes "remove animations" through the same accessibility setting
 * the media query reads, and someone who has asked for a calmer device has not
 * asked for a quieter one and a buzzier one.
 */
function enabled(): boolean {
  return Capacitor.isNativePlatform() && !prefersReducedMotion();
}

/** A message left the device. The lightest tap there is — this fires many
 *  times a minute in an active conversation. */
export async function tapSend(): Promise<void> {
  if (!enabled()) return;
  await Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
}

/** Something completed that the user was waiting on: a contact verified, a
 *  purchase, a room created. */
export async function tapSuccess(): Promise<void> {
  if (!enabled()) return;
  await Haptics.notification({ type: NotificationType.Success }).catch(() => {});
}

/** Something the user should stop and look at — a key change, a signature that
 *  did not verify. */
export async function tapWarning(): Promise<void> {
  if (!enabled()) return;
  await Haptics.notification({ type: NotificationType.Warning }).catch(() => {});
}
