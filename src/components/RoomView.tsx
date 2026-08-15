import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  ArrowLeft,
  Lock,
  LogOut,
  Send,
  ShieldAlert,
  ShieldQuestion,
  Trash2,
  UserMinus,
  Users,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  deleteRoom,
  leaveRoom,
  openRoomRows,
  roomColour,
  roomKeyFor,
  removeMember,
  roomMembers,
  roomSigningKeys,
  sendRoomMessage,
  type RoomMessage,
  type RoomParticipant,
  type RoomSummary,
} from '../lib/rooms';
import { formatDisplayName, nicknameFor } from '../lib/nicknames';
import { formatTime } from '../lib/time';
import { prefersReducedMotion } from '../lib/motion';
import { tapSend } from '../lib/haptics';
import { forgetChannel, reportChannelStatus, useConnection } from '../lib/connection';
import { MAX_MESSAGE_LENGTH } from '../lib/conversation';
import { useToast } from '../hooks/useToast';
import type { Profile } from '../lib/types';
import { MessageText } from './MessageText';

interface RoomViewProps {
  session: Session;
  room: RoomSummary;
  identity: import('../lib/crypto/keys').Identity;
  onBack: () => void;
  onLeft: () => void;
}

const PAGE_SIZE = 50;
/** Polling cadence while realtime is down, matching ChatRoom's fallback. */
const POLL_DEGRADED_MS = 5_000;

/**
 * A room conversation.
 *
 * Signatures are checked before anything is decrypted, in `openRoomRows`. A
 * message that fails renders as a warning bubble rather than being dropped —
 * hiding it would conceal an attack in progress, which is precisely the case
 * the signature exists to surface.
 */
export function RoomView({ session, room, identity, onBack, onLeft }: RoomViewProps) {
  const me = session.user.id;
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [members, setMembers] = useState<RoomParticipant[]>([]);
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());
  const [roomKey, setRoomKey] = useState<Uint8Array | null>(null);
  const [keyMissing, setKeyMissing] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  /** Who is mid-removal, so their row can show it and not be tapped twice. */
  const [removing, setRemoving] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const { generation, live } = useConnection();

  const isOwner = room.created_by === me;

  const colourFor = useMemo(() => {
    const map = new Map(members.map((m) => [m.user_id, roomColour(m.colour_index)]));
    return (userId: string) => map.get(userId) ?? 'text-base-content';
  }, [members]);

  const nameFor = useCallback(
    (userId: string) => {
      if (userId === me) return 'You';
      const profile = profiles.get(userId);
      return formatDisplayName(nicknameFor(userId), profile?.display_name);
    },
    [me, profiles]
  );

  // The key first: every other fetch is useless without it, and a null key is
  // a state the user must be told about rather than shown as an empty room.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const key = await roomKeyFor(room.id, identity);
      if (!alive) return;
      setRoomKey(key);
      setKeyMissing(!key);
    })();
    return () => {
      alive = false;
    };
  }, [room.id, identity, generation]);

  const loadMembers = useCallback(async () => {
    const rows = await roomMembers(room.id);
    setMembers(rows);
    const { data } = await supabase
      .from('profiles')
      .select('id, display_name, avatar_url')
      .in('id', rows.map((r) => r.user_id));
    setProfiles(new Map(((data as Profile[] | null) ?? []).map((p) => [p.id, p])));
  }, [room.id]);

  const loadMessages = useCallback(async () => {
    if (!roomKey) return;
    const { data, error } = await supabase
      .from('room_messages')
      .select('id, room_id, sender_id, ciphertext, nonce, signature, created_at')
      .eq('room_id', room.id)
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE);
    if (error) return;

    const rows = ((data as RoomMessage[] | null) ?? []).slice().reverse();
    const signing = await roomSigningKeys([...new Set(rows.map((r) => r.sender_id))]);
    setMessages(await openRoomRows(rows, roomKey, signing));
  }, [room.id, roomKey]);

  /**
   * Verify, open and append one row that arrived over the socket.
   *
   * The subscription used to call `loadMessages`, which re-read the newest
   * fifty rows and every sender's profile for a row the event had already
   * delivered in full. In a room of five that is five clients each pulling
   * fifty messages for every one message anybody sends, and the cost grows with
   * the room rather than with the conversation.
   *
   * De-duplicated by id because the sender's own insert is echoed back here as
   * well as returned to `send`, and because a poll running underneath a
   * recovering socket can deliver the same row twice.
   */
  const appendMessage = useCallback(
    async (row: RoomMessage) => {
      if (!roomKey) return;
      const signing = await roomSigningKeys([row.sender_id]);
      const [opened] = await openRoomRows([row], roomKey, signing);
      setMessages((prev) =>
        prev.some((m) => m.id === opened.id)
          ? prev.map((m) => (m.id === opened.id ? opened : m))
          : [...prev, opened]
      );
    },
    [roomKey]
  );

  useEffect(() => {
    void loadMembers();
  }, [loadMembers, generation]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages, generation]);

  // Realtime, with the same channel-status reporting every other subscription
  // in the app uses, so `lib/connection.ts`'s wake and reconnect handling
  // applies here unchanged.
  useEffect(() => {
    if (!roomKey) return;
    const channelKey = `room:${room.id}:${generation}`;
    const channel = supabase
      .channel(channelKey)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'room_messages', filter: `room_id=eq.${room.id}` },
        (payload) => void appendMessage(payload.new as RoomMessage)
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'room_participants',
          filter: `room_id=eq.${room.id}`,
        },
        () => void loadMembers()
      )
      .subscribe((status) => reportChannelStatus(channelKey, status));

    return () => {
      forgetChannel(channelKey);
      void supabase.removeChannel(channel);
    };
  }, [room.id, roomKey, generation, appendMessage, loadMembers]);

  // Polling fallback for networks that stall `wss://` while ordinary HTTPS
  // keeps working — the banner already says so; this is what keeps the room
  // moving underneath it.
  useEffect(() => {
    if (live || !roomKey) return;
    const id = setInterval(() => void loadMessages(), POLL_DEGRADED_MS);
    return () => clearInterval(id);
  }, [live, roomKey, loadMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'end',
    });
  }, [messages.length]);

  async function send() {
    const text = draft.trim();
    if (!text || !roomKey || sending) return;
    void tapSend();
    setSending(true);
    try {
      const row = await sendRoomMessage(room.id, me, identity, roomKey, text);
      setDraft('');
      // The insert returned the row, so the bubble is built from it rather than
      // by re-reading the page it belongs to. The echo of our own insert
      // arrives over the socket a moment later and `appendMessage`
      // de-duplicates it by id.
      await appendMessage(row);
    } catch {
      toast.error('Could not send. Check your connection.');
    } finally {
      setSending(false);
    }
  }

  /** Owner-only. The panel below already tells the owner what removal does and
   *  does not reach; this is the action that copy was written for. */
  async function handleRemove(userId: string) {
    setRemoving(userId);
    try {
      await removeMember(room.id, userId);
      await loadMembers();
    } catch {
      toast.error('Could not remove them from the room.');
    } finally {
      setRemoving(null);
    }
  }

  async function handleLeave() {
    try {
      if (isOwner) await deleteRoom(room.id);
      else await leaveRoom(room.id, me);
      onLeft();
    } catch {
      toast.error(isOwner ? 'Could not delete the room.' : 'Could not leave the room.');
    }
  }

  return (
    <div className="flex flex-col h-full bg-base-200/50 min-h-0">
      {/* Same top edge as ChatHeader, and inset the same way — see the comment
          there for why `lg:` puts it back. */}
      <header className="navbar bg-base-100 px-2 sm:px-4 pt-[calc(0.5rem+var(--safe-top))] shrink-0 border-b border-base-content/5 min-h-[3.5rem] gap-1">
        <button className="btn btn-ghost btn-sm btn-square lg:hidden" onClick={onBack} title="Back">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-8 h-8 rounded-xl bg-primary/15 text-primary flex items-center justify-center shrink-0">
              <Users className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <p className="font-semibold text-sm truncate">{room.title}</p>
              <p className="text-xs text-base-content/55 truncate">
                {members.length} {members.length === 1 ? 'member' : 'members'} · end-to-end
                encrypted
              </p>
            </div>
          </div>
        </div>
        <button
          className="btn btn-ghost btn-sm btn-square"
          onClick={() => setShowMembers((v) => !v)}
          title="Members"
        >
          <Users className="w-4 h-4" />
        </button>
        <button
          className="btn btn-ghost btn-sm btn-square text-error"
          onClick={() => void handleLeave()}
          title={isOwner ? 'Delete room' : 'Leave room'}
        >
          {isOwner ? <Trash2 className="w-4 h-4" /> : <LogOut className="w-4 h-4" />}
        </button>
      </header>

      {showMembers && (
        <div className="bg-base-100 border-b border-base-content/5 px-4 py-3 shrink-0">
          <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
            {members.map((m) => (
              <li
                key={m.user_id}
                className={`flex items-center gap-1 text-xs font-medium ${roomColour(m.colour_index)}`}
              >
                {nameFor(m.user_id)}
                {isOwner && m.user_id !== me && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs btn-circle text-base-content/50 hover:text-error"
                    onClick={() => void handleRemove(m.user_id)}
                    disabled={removing !== null}
                    title={`Remove ${nameFor(m.user_id)} from this room`}
                    aria-label={`Remove ${nameFor(m.user_id)} from this room`}
                  >
                    {removing === m.user_id ? (
                      <span className="loading loading-spinner loading-xs" />
                    ) : (
                      <UserMinus className="w-3 h-3" />
                    )}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {isOwner && (
            <p className="text-[11px] text-base-content/55 mt-2">
              Removing someone stops them reading anything sent after that. They keep what they
              already downloaded, and nothing can take that back.
            </p>
          )}
        </div>
      )}

      {keyMissing && (
        <div className="alert alert-error rounded-none text-sm">
          <ShieldAlert className="w-4 h-4 shrink-0" />
          <span>
            This device has no key for this room. You may have been removed, or the key was sealed
            to an identity this phone no longer holds.
          </span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 min-h-0">
        {messages.length === 0 && !keyMissing && (
          <div className="h-full flex flex-col items-center justify-center text-center px-6">
            <span className="w-16 h-16 rounded-2xl bg-base-content/5 flex items-center justify-center mb-3">
              <Lock className="w-7 h-7 text-base-content/60" />
            </span>
            <p className="text-sm font-medium text-base-content/60">Nothing here yet</p>
            <p className="text-xs text-base-content/55 mt-1 max-w-xs">
              Everyone in this room holds the same key. Messages are signed, so the app can tell you
              who really wrote each one.
            </p>
          </div>
        )}

        <ul className="space-y-2.5">
          {messages.map((m) => {
            const mine = m.sender_id === me;
            return (
              <li
                key={m.id}
                // Same side marker as MessageBubble — see index.css.
                data-own={mine}
                className={`flex ${mine ? 'justify-end' : 'justify-start'} animate-message-in`}
              >
                <div
                  className={`max-w-[85%] sm:max-w-[70%] rounded-2xl px-3 py-2 ${
                    m.sender === 'unverified'
                      ? 'bg-error/10 border border-error/40'
                      : m.sender === 'unknown'
                        ? 'bg-warning/10 border border-warning/40'
                        : mine
                          ? 'bg-primary text-primary-content'
                          : 'bg-base-100 border border-base-content/5'
                  }`}
                >
                  {!mine && (
                    <p className={`text-[11px] font-semibold mb-0.5 ${colourFor(m.sender_id)}`}>
                      {nameFor(m.sender_id)}
                    </p>
                  )}

                  {m.sender === 'unverified' ? (
                    <p className="flex items-start gap-1.5 text-sm text-error">
                      <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>
                        Unverified sender. This message claims to be from{' '}
                        {nameFor(m.sender_id)}, but its signature does not match their key. It has
                        not been opened.
                      </span>
                    </p>
                  ) : m.sender === 'unknown' ? (
                    <p className="flex items-start gap-1.5 text-sm text-warning">
                      <ShieldQuestion className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>
                        This sender has published no signing key, so there is nothing to check this
                        message against.
                      </span>
                    </p>
                  ) : m.text === null ? (
                    <p className="flex items-start gap-1.5 text-sm italic text-base-content/60">
                      <Lock className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>Sent before you joined, sealed with a key you do not have.</span>
                    </p>
                  ) : (
                    <div className="text-sm whitespace-pre-wrap break-words">
                      <MessageText text={m.text ?? ''} />
                    </div>
                  )}

                  <p
                    className={`text-[10px] mt-1 text-right ${
                      mine && m.sender === 'verified'
                        ? 'text-primary-content/60'
                        : 'text-base-content/60'
                    }`}
                  >
                    {formatTime(m.created_at)}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
        <div ref={bottomRef} />
      </div>

      <div className="bg-base-100 border-t border-base-content/5 p-2.5 pb-[calc(0.625rem+var(--safe-bottom))] shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            className="textarea flex-1 bg-base-200/50 border border-base-content/10 focus:border-primary resize-none min-h-[2.75rem] max-h-40 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            rows={1}
            value={draft}
            maxLength={MAX_MESSAGE_LENGTH}
            placeholder={keyMissing ? 'You cannot post to this room' : 'Message'}
            disabled={keyMissing}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button
            className="btn btn-primary btn-square"
            onClick={() => void send()}
            disabled={sending || keyMissing || !draft.trim()}
            title="Send"
          >
            {sending ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
