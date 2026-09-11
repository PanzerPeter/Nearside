// Turning a flat list of search hits into one section per conversation.
//
// `searchEverywhere` answers in one pass over the mirror and returns rows in
// time order, which is the right shape for the query and the wrong one for the
// reader: forty hits interleaved across nine chats is a list nobody can use.
// Grouped, the same forty are nine sections you can skim.
//
// Pure, so the ordering rules below are settled in the node suite rather than
// by looking at a screen and hoping.

import type { CachedMessage } from './localdb';

export interface SearchGroup {
  /** The conversation: a friend's user id, or a room's. Which of the two it is
   *  is the caller's to know — the mirror stores both under `peer_id` and has
   *  no opinion. */
  conversationId: string;
  /** Newest first, the same order they arrived in. */
  hits: CachedMessage[];
  /** When the newest hit in this conversation was sent, which is what the
   *  sections are ordered by. */
  newestAt: string;
}

/**
 * How many hits one conversation shows before the rest are folded away.
 *
 * Without a cap, a single chatty conversation with sixty matches pushes every
 * other conversation off the screen — and the reason to search everything at
 * once is to find out *which* conversation, which is exactly the question that
 * list stops answering.
 */
export const HITS_PER_CONVERSATION = 4;

/**
 * The hits as one section per conversation, most recently active first.
 *
 * Ordered by each conversation's newest hit rather than by how many it has. A
 * count ordering would put a long-dead thread that once used the word forty
 * times above the chat where it was said this morning, and the recent one is
 * almost always the one being looked for.
 */
export function groupHits(hits: readonly CachedMessage[]): SearchGroup[] {
  const byConversation = new Map<string, SearchGroup>();
  for (const hit of hits) {
    const group = byConversation.get(hit.peer_id);
    if (group) {
      group.hits.push(hit);
      if (hit.created_at > group.newestAt) group.newestAt = hit.created_at;
      continue;
    }
    byConversation.set(hit.peer_id, {
      conversationId: hit.peer_id,
      hits: [hit],
      newestAt: hit.created_at,
    });
  }
  return [...byConversation.values()].sort((a, b) => b.newestAt.localeCompare(a.newestAt));
}

/** The hits this section shows, and how many it is holding back. */
export function visibleHits(group: SearchGroup): { shown: CachedMessage[]; more: number } {
  return {
    shown: group.hits.slice(0, HITS_PER_CONVERSATION),
    more: Math.max(0, group.hits.length - HITS_PER_CONVERSATION),
  };
}
