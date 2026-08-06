export interface Profile {
  id: string;
  username: string;
  avatar_url?: string | null;
  last_seen_at?: string | null;
}

export interface Friendship {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: 'pending' | 'accepted';
  created_at: string;
  profiles?: Profile;
}

export type MediaType = 'image' | 'video' | 'audio';

/** Media rendered as a visual attachment; a voice note gets its own player. */
export type VisualMediaType = Exclude<MediaType, 'audio'>;

export interface Message {
  id: string;
  user_id: string;
  receiver_id: string;
  /** Sealed body, base64, with its nonce beside it. These are the columns as
   *  fetched; `openRows` opens them at the boundary. */
  ciphertext: string | null;
  nonce: string | null;
  /** Client-only, never a column — there is no plaintext column to write it
   *  back to, which is the point. Set by `openRows` and read by every render
   *  site. Null means either a captionless media message or a body this device
   *  could not open; `decrypt_failed` is what tells those two apart. */
  text: string | null;
  /** Client-only, never a column: this row is sealed and this device could not
   *  open it. Distinct from a null `text`, which is an ordinary captionless
   *  media message. */
  decrypt_failed?: boolean;
  media_path: string | null;
  media_type: MediaType | null;
  /** Recorded length of a voice note. Null for every other kind of media —
   *  stored because a WebM from MediaRecorder carries no duration header, so
   *  the bubble could not otherwise show a length before the file is fetched. */
  media_duration_ms: number | null;
  reply_to_id: string | null;
  /** True when this message was created by forwarding another one rather than
   *  by typing it. A flag, not a pointer: see 0018 for why the original is
   *  deliberately not named. Immutable once written. */
  forwarded: boolean;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string;
}

export interface Reaction {
  id: string;
  message_id: string;
  user_id: string;
  emoji: string;
  created_at: string;
}

/** Safe first-letter for avatar fallbacks. */
export function initial(username?: string | null): string {
  return username?.trim()?.[0]?.toUpperCase() ?? '?';
}

/** One row of the sidebar, as returned by the conversation_list() RPC. */
export interface ConversationSummary {
  peer_id: string;
  username: string;
  avatar_url: string | null;
  last_message: string | null;
  last_media_type: MediaType | null;
  last_sender_id: string | null;
  last_at: string | null;
  last_seen_at: string | null;
}

/** A message not yet acknowledged by the server. `id` is a client uuid. */
export interface PendingMessage {
  id: string;
  user_id: string;
  receiver_id: string;
  /** Plaintext, deliberately. The outbox exists for messages that could not
   *  reach the network; it lives in app-private storage beside the local
   *  mirror, which already holds plaintext, and sealing at queue time would
   *  freeze a peer key that may rotate before the flush. `attemptSend` seals
   *  at send time instead. */
  text: string;
  reply_to_id: string | null;
  created_at: string;
  attempts: number;
}
