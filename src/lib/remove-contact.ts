/**
 * Ending a contact, which is the only chat-list action that reaches the server.
 *
 * "Delete chat" cannot mean "hide the row": the person would go on being an
 * accepted contact, able to message and call, and the row would come back with
 * their next message. So it ends the friendship, drops this device's copy of
 * everything about them, and marks them dismissed so they cannot put a fresh
 * request in front of you (`chat-flags.ts`, `visibleRequests`).
 *
 * What it deliberately does not do is touch their copy. Nothing here can, and
 * the confirmation says so rather than letting people believe otherwise.
 */

import { supabase } from './supabase';
import { clearConversation, forgetChatFlags } from './localdb';
import { setDismissed } from './chat-flags';
import { clearNickname } from './nicknames';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The PostgREST `.or()` expression matching a friendship in either direction.
 *
 * Both rows, always. A friendship is not ordered — two people who add each
 * other in the same minute produce A→B and B→A, and the client's
 * check-then-insert is not atomic — so deleting only the row this client knows
 * about can leave the other one 'accepted', and every policy that gates on the
 * friendship goes on passing.
 *
 * The ids are validated rather than escaped because there is nothing to escape
 * with: this is a filter *string*, and a value carrying a comma or a paren ends
 * the expression early and matches a wider set than the pair.
 */
export function friendshipPairFilter(me: string, peer: string): string {
  if (!UUID.test(me) || !UUID.test(peer)) throw new Error('friendshipPairFilter: not a uuid');
  return (
    `and(requester_id.eq.${me},addressee_id.eq.${peer}),` +
    `and(requester_id.eq.${peer},addressee_id.eq.${me})`
  );
}

/**
 * End the friendship and remove this device's copy of the conversation.
 *
 * The server delete comes first: if it fails, nothing local has been thrown
 * away and the user can try again. The local half is best-effort after that —
 * a mirror row that outlives its friendship is untidy, but a friendship that
 * outlives the user's decision to end it is a person who can still message
 * them.
 */
export async function removeContact(me: string, peer: string): Promise<string | null> {
  const { error } = await supabase
    .from('friendships')
    .delete()
    .or(friendshipPairFilter(me, peer));
  if (error) {
    console.error('remove contact failed', error);
    return 'Could not remove this contact. Check your connection and try again.';
  }

  // Dismissed before the flags are dropped, because dismissal is the one flag
  // that has to survive the removal: it is what stops them asking again.
  await clearConversation(peer).catch(() => {});
  await forgetChatFlags(peer).catch(() => {});
  await setDismissed(peer, true).catch(() => {});
  await clearNickname(me, peer).catch(() => {});
  return null;
}
