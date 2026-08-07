import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Modal } from './Modal';
import { Avatar } from './Avatar';
import { useToast } from '../hooks/useToast';
import { isSelfChat, messageSnippet, sortConversations } from '../lib/conversation';
import { formatDisplayName, useNicknameMap } from '../lib/nicknames';
import {
  describeForwardFailure,
  forwardMessage,
  matchesTarget,
  type ForwardFailure,
} from '../lib/forward';
import type { Identity } from '../lib/crypto/keys';
import type { ConversationSummary, Message } from '../lib/types';
import { NotebookPen, Search } from 'lucide-react';

interface ForwardModalProps {
  me: string;
  /** The message being passed along. */
  msg: Message;
  /** The conversation it is being forwarded *from* — offered as a target it
   *  would only ever mean "post this again where it already is". */
  fromPeerId: string;
  /** Needed to seal a forward that lands in the vault. */
  identity: Identity;
  onClose: () => void;
}

/** A row of the picker, with its name already resolved. */
interface Target {
  peerId: string;
  display_name: string;
  avatarUrl: string | null;
  label: string;
  isSelf: boolean;
}

/**
 * Choose where a message goes next.
 *
 * Reads the same `conversation_list()` RPC the sidebar does, so the picker can
 * never offer somebody you are not allowed to message — the RPC returns
 * accepted friends and your own notes, which is exactly the set
 * `messages_insert_sender` permits. Ordering comes from `sortConversations`
 * too, so your notes are pinned to the top here for the same reason they are
 * there: it is the most common forward destination and it should not move.
 */
export function ForwardModal({ me, msg, fromPeerId, identity, onClose }: ForwardModalProps) {
  const [rows, setRows] = useState<ConversationSummary[] | null>(null);
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
        toast.error('Could not load your conversations.');
        setRows([]);
        return;
      }
      setRows(sortConversations((data ?? []) as ConversationSummary[], me));
    });
    return () => {
      active = false;
    };
    // `toast` is a stable useCallback (see useToast.tsx).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  const targets: Target[] = useMemo(() => {
    return (rows ?? [])
      // The conversation this message is already in is not a destination.
      .filter((row) => row.peer_id !== fromPeerId)
      .map((row) => {
        const isSelf = isSelfChat(me, row.peer_id);
        return {
          peerId: row.peer_id,
          display_name: row.display_name,
          avatarUrl: row.avatar_url,
          label: formatDisplayName(nicknames.get(row.peer_id), row.display_name, isSelf),
          isSelf,
        };
      });
  }, [rows, fromPeerId, me, nicknames]);

  const visible = useMemo(
    () => targets.filter((t) => matchesTarget(t.label, t.display_name, query)),
    [targets, query]
  );

  function toggle(peerId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(peerId)) next.delete(peerId);
      else next.add(peerId);
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

    const chosen = targets.filter((t) => selected.has(t.peerId));
    const delivered: string[] = [];
    const failures: Array<{ label: string; reason: ForwardFailure }> = [];

    for (const target of chosen) {
      const result = await forwardMessage(me, msg, target.peerId, identity);
      if (result.ok) delivered.push(target.label);
      else failures.push({ label: target.label, reason: result.reason });
    }

    setSending(false);

    if (delivered.length > 0) {
      toast.success(
        delivered.length === 1
          ? `Forwarded to ${delivered[0]}.`
          : `Forwarded to ${delivered.length} chats.`
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

  const preview = messageSnippet(msg);

  return (
    <Modal
      title="Forward to"
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
              `Send to ${selected.size}`
            ) : (
              'Send'
            )}
          </button>
        </>
      }
    >
      {preview && (
        <p className="mb-3 px-3 py-2 rounded-lg bg-base-200/70 border-l-2 border-primary text-xs text-base-content/70 line-clamp-2">
          {preview}
        </p>
      )}

      <div className="flex items-center gap-2 mb-2">
        <Search className="w-4 h-4 text-base-content/55 shrink-0" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations..."
          className="input input-sm flex-1 bg-base-200/50 border border-base-content/10 focus:border-primary"
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
          <p className="flex items-center justify-center h-full text-center text-sm text-base-content/55 px-4">
            {targets.length === 0
              ? 'No other conversations to forward to.'
              : 'No conversation matches that.'}
          </p>
        ) : (
          <ul className="space-y-1">
            {visible.map((target) => (
              <li key={target.peerId}>
                <label
                  className={`flex items-center gap-3 px-2 py-2 rounded-xl cursor-pointer transition-colors ${
                    selected.has(target.peerId) ? 'bg-primary/15' : 'hover:bg-base-content/5'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="checkbox checkbox-sm checkbox-primary shrink-0"
                    checked={selected.has(target.peerId)}
                    onChange={() => toggle(target.peerId)}
                    disabled={sending}
                  />
                  <div className="relative shrink-0" style={{ width: 32, height: 32 }}>
                    <Avatar display_name={target.display_name} url={target.avatarUrl} size={32} />
                    {target.isSelf && (
                      <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-base-100 p-0.5">
                        <NotebookPen className="w-2.5 h-2.5 text-primary" />
                      </span>
                    )}
                  </div>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{target.label}</span>
                    {/* The handle stays visible under a nickname for the same
                        reason it does in the sidebar: two people you renamed
                        have to be tellable apart by something they chose. */}
                    {!target.isSelf && target.label !== `@${target.display_name}` && (
                      <span className="block truncate text-[0.7rem] text-base-content/60">
                        @{target.display_name}
                      </span>
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
