import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Modal } from './Modal';
import { Avatar } from './Avatar';
import { useToast } from '../hooks/useToast';
import { isSelfChat, sortConversations } from '../lib/conversation';
import { formatDisplayName, useNicknameMap } from '../lib/nicknames';
import {
  describeForwardFailure,
  forwardMessage,
  matchesTarget,
  type ForwardFailure,
  type ForwardSource,
  type ForwardTarget,
} from '../lib/forward';
import { listRooms, type RoomSummary } from '../lib/rooms';
import type { Identity } from '../lib/crypto/keys';
import type { ConversationSummary } from '../lib/types';
import { NotebookPen, Search, Users } from 'lucide-react';
import { useT } from '../hooks/useT';

interface ForwardModalProps {
  me: string;
  /**
   * What is being passed along, already narrowed to what travels — see
   * `peerSource` and `roomSource`. The modal never sees the rows they came
   * off, which is what keeps a group signature from following one.
   *
   * A list, because a selection of several is forwarded through exactly this
   * sheet: picking the destinations once for nine messages is the whole point,
   * and a second sheet for the plural case would be a second set of rules
   * about what may be forwarded where.
   */
  sources: readonly ForwardSource[];
  /** A one-line preview of the message, drawn at the top of the sheet. */
  preview: string;
  /** The conversation it is being forwarded *from*, by peer id or room id.
   *  Offered as a target it would only ever mean "post this again where it
   *  already is". */
  fromKey: string;
  /** Needed to seal a forward that lands in the vault. */
  identity: Identity;
  onClose: () => void;
}

/** A row of the picker, with its name already resolved. Peers and groups share
 *  one shape so they can share one ordering rule — see `sortConversations`. */
interface Target {
  /** Unique across both kinds: a peer id or a room id. */
  key: string;
  target: ForwardTarget;
  display_name: string;
  avatarUrl: string | null;
  label: string;
  isSelf: boolean;
  /** Groups only. Drawn under the title where a peer shows its handle. */
  memberCount: number | null;
  /** Sort keys, in the shape `sortConversations` reads. */
  peer_id: string;
  last_at: string | null;
}

/**
 * Choose where a message goes next.
 *
 * Reads the same `conversation_list()` RPC the sidebar does and the same
 * `rooms_for_me()` the group list does, so the picker can never offer somebody
 * you are not allowed to message — between them they return accepted friends,
 * your own notes and the groups you are a member of, which is exactly the set
 * the two insert policies permit.
 *
 * Peers and groups are one list under one ordering rule rather than two
 * sections. `sortConversations` already pins your notes to the top and orders
 * the rest by last activity; a group is a conversation by that measure too, and
 * a separate section would put the group you were talking in five minutes ago
 * below a friend you last messaged in spring.
 *
 * A group's key is resolved at send time, not here: drawing this list would
 * otherwise cost one request per group, for a key most of them will not need.
 */
export function ForwardModal({
  me,
  sources,
  preview,
  fromKey,
  identity,
  onClose,
}: ForwardModalProps) {
  const t = useT();
  const [rows, setRows] = useState<ConversationSummary[] | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const nicknames = useNicknameMap();
  const toast = useToast();

  useEffect(() => {
    let active = true;
    supabase.rpc('conversation_list').then(({ data, error }) => {
      if (!active) return;
      if (error) {
        toast.error(t('forward.loadFailed'));
        setRows([]);
        return;
      }
      setRows((data ?? []) as ConversationSummary[]);
    });
    // Groups load beside the friends rather than after them, and a failure here
    // is silent: a picker with no groups in it is still a usable picker, and a
    // second red toast for the same open would say the sheet is broken.
    listRooms()
      .then((list) => {
        if (active) setRooms(list);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
    // `toast` is a stable useCallback (see useToast.tsx).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  const targets: Target[] = useMemo(() => {
    const peers: Target[] = (rows ?? []).map((row) => {
      const isSelf = isSelfChat(me, row.peer_id);
      return {
        key: row.peer_id,
        target: { kind: 'peer' as const, peerId: row.peer_id },
        display_name: row.display_name,
        avatarUrl: row.avatar_url,
        label: formatDisplayName(nicknames.get(row.peer_id), row.display_name, isSelf),
        isSelf,
        memberCount: null,
        peer_id: row.peer_id,
        last_at: row.last_at,
      };
    });

    const groups: Target[] = rooms.map((room) => ({
      key: room.id,
      target: { kind: 'room' as const, roomId: room.id },
      // A group has no handle behind its title, so both fields carry it: the
      // filter searches display_name, and the row draws label.
      display_name: room.title,
      avatarUrl: null,
      label: room.title,
      isSelf: false,
      memberCount: room.member_count,
      peer_id: room.id,
      last_at: room.last_at,
    }));

    return (
      sortConversations([...peers, ...groups], me)
        // The conversation this message is already in is not a destination.
        .filter((row) => row.key !== fromKey)
    );
  }, [rows, rooms, fromKey, me, nicknames]);

  const visible = useMemo(
    () => targets.filter((t) => matchesTarget(t.label, t.display_name, query)),
    [targets, query]
  );

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /**
   * Forward to every checked conversation, one at a time.
   *
   * Sequential rather than `Promise.all`: each media forward is a storage copy
   * plus an insert, and the messages table is rate limited (0009) — firing five
   * at once is the reliable way to have some of them refused. The modal stays
   * open if nothing got through, so the selection is not lost.
   */
  async function send() {
    if (selected.size === 0 || sending) return;
    setSending(true);

    const chosen = targets.filter((t) => selected.has(t.key));
    const delivered: string[] = [];
    const failures: Array<{ label: string; reason: ForwardFailure }> = [];

    for (const target of chosen) {
      // In the order they were sent, one at a time: nine messages arriving as
      // nine rows in the order the conversation had them is the only reading
      // that makes sense, and firing them together leaves that to chance.
      // A target counts as delivered only if every message reached it —
      // "sent to Alice" while three of the nine failed is the wrong claim.
      let ok = true;
      for (const source of sources) {
        const result = await forwardMessage(me, source, target.target, identity);
        if (result.ok) continue;
        ok = false;
        failures.push({ label: target.label, reason: result.reason });
        break;
      }
      if (ok) delivered.push(target.label);
    }

    setSending(false);

    if (delivered.length > 0) {
      toast.success(
        delivered.length === 1
          ? t('forward.doneOne', { name: delivered[0] })
          : t('forward.doneMany', { count: delivered.length })
      );
    }
    // One toast per distinct cause, not per target: five chats refused for the
    // same missing attachment is one thing that went wrong, said once.
    const seen = new Set<ForwardFailure>();
    for (const failure of failures) {
      if (seen.has(failure.reason)) continue;
      seen.add(failure.reason);
      toast.error(describeForwardFailure(failure.reason, failure.label));
    }

    if (delivered.length > 0) onClose();
  }

  return (
    <Modal
      title={t('forward.title')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={send}
            disabled={selected.size === 0 || sending}
          >
            {sending ? (
              <span className="loading loading-spinner loading-xs" />
            ) : selected.size > 1 ? (
              t('forward.sendToCount', { count: selected.size })
            ) : (
              'Send'
            )}
          </button>
        </>
      }
    >
      {preview && (
        <p className="mb-3 px-3 py-2 rounded-field bg-base-200/70 border-l-2 border-primary text-meta text-strong line-clamp-2">
          {preview}
        </p>
      )}

      <div className="flex items-center gap-2 mb-2">
        <Search className="w-4 h-4 text-muted shrink-0" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('forward.searchPlaceholder')}
          className="input input-sm flex-1 bg-base-200/50 border border-hairline focus:border-primary"
          autoFocus
        />
      </div>

      {/* Fixed height rather than max-height: the list shrinking as you type
          would walk the Send button up the screen under the cursor. */}
      <div className="h-64 overflow-y-auto -mx-1 px-1">
        {rows === null ? (
          <div className="flex items-center justify-center h-full">
            <span className="loading loading-spinner loading-sm" />
          </div>
        ) : visible.length === 0 ? (
          <p className="flex items-center justify-center h-full text-center text-body text-muted px-4">
            {targets.length === 0
              ? t('forward.noTargets')
              : t('forward.noMatch')}
          </p>
        ) : (
          <ul className="space-y-1">
            {visible.map((target) => (
              <li key={target.key}>
                <label
                  className={`flex items-center gap-3 px-2 py-2 rounded-box cursor-pointer transition-colors ${
                    selected.has(target.key) ? 'bg-primary/15' : 'hover:bg-wash'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="checkbox checkbox-sm checkbox-primary shrink-0"
                    checked={selected.has(target.key)}
                    onChange={() => toggle(target.key)}
                    disabled={sending}
                  />
                  <div className="relative shrink-0" style={{ width: 32, height: 32 }}>
                    {target.memberCount === null ? (
                      <Avatar display_name={target.display_name} url={target.avatarUrl} size={32} />
                    ) : (
                      /* A group has no picture to show, and an initial drawn
                         from its title reads as a person. The icon is what says
                         this row is several people. */
                      <span className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/15">
                        <Users className="w-4 h-4 text-primary" />
                      </span>
                    )}
                    {target.isSelf && (
                      <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-base-100 p-0.5">
                        <NotebookPen className="w-2.5 h-2.5 text-primary" />
                      </span>
                    )}
                  </div>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-medium">{target.label}</span>
                    {/* The handle stays visible under a nickname for the same
                        reason it does in the sidebar: two people you renamed
                        have to be tellable apart by something they chose. A
                        group says how many people are in it instead — the one
                        thing worth knowing before you post into it. */}
                    {target.memberCount !== null ? (
                      <span className="block truncate text-micro text-muted">
                        {t('room.memberCount', { count: target.memberCount })}
                      </span>
                    ) : (
                      !target.isSelf &&
                      target.label !== target.display_name && (
                        <span className="block truncate text-micro text-muted">
                          {target.display_name}
                        </span>
                      )
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
