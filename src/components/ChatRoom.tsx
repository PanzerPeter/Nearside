import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Session } from '@supabase/supabase-js';
import { Message, Profile } from '../lib/types';
import { isSelfChat, messageSnippet } from '../lib/conversation';
import { useConnection } from '../lib/connection';
import {
  alertLevelFor,
  loadChatFlags,
  setAlertLevel,
  subscribeChatFlags,
  type AlertLevel,
} from '../lib/chat-flags';
import { supabase } from '../lib/supabase';
import {
  loadConversationPin,
  pinConversationMessage,
  unpinConversationMessage,
  type PinnedMessage,
} from '../lib/pinned-message';
import { PinnedBanner } from './PinnedBanner';
import { describeTimerChange } from '../lib/disappearing';
import { openRows } from '../lib/sealed-body';
import { putSealedRows } from '../lib/localdb';
import { PAGE_SIZE, fetchLatestPage, fetchOlderPage } from '../lib/message-queries';
import { peerPublicKey } from '../lib/peer-keys';
import type { Identity } from '../lib/crypto/keys';
import { formatDisplayName, useNickname } from '../lib/nicknames';
import { tapSend, tapSuccess } from '../lib/haptics';
import { Composer, ComposerHandle } from './Composer';
import { ConversationSearch } from './ConversationSearch';
import { ConversationPanel } from './ConversationPanel';
import { ChatBackgroundModal } from './ChatBackgroundModal';
import { NicknameModal } from './NicknameModal';
import { ProfileCard } from './ProfileCard';
import { ForwardModal } from './ForwardModal';
import { CornerUpRight, Trash2 } from 'lucide-react';
import { selectionPowers, toggleSelected } from '../lib/selection';
import { isForwardable } from '../lib/forward';
import { ReactionSheet } from './ReactionSheet';
import { peerSource } from '../lib/forward';
import { AskSealedModal } from './AskSealedModal';
import { VerifyContact } from './VerifyContact';
import { ChatHeader } from './ChatHeader';
import { MessageThread } from './MessageThread';
import { GalleryProvider } from '../hooks/useGallery';
import { useShortcut } from '../hooks/useShortcut';
import { useExportChat } from '../hooks/useExportChat';
import { useHistoryBackfill } from '../hooks/useHistoryBackfill';
import { KeyChangedNotice } from './KeyChangedNotice';
import { Modal } from './Modal';
import { useReactions } from '../hooks/useReactions';
import { useReplyTargets } from '../hooks/useReplyTargets';
import { useChatBackground } from '../hooks/useChatBackground';
import { usePresenceStatus } from '../hooks/usePresence';
import { useToast } from '../hooks/useToast';
import { useT } from '../hooks/useT';
import { useChatThread } from '../hooks/useChatThread';
import { usePeerTrust } from '../hooks/usePeerTrust';
import { useMediaSend } from '../hooks/useMediaSend';
import { useStickers } from '../hooks/useStickers';
import { usePins } from '../hooks/usePins';
import { restorePinned } from '../lib/pin-restore';
import { unpinMedia } from '../lib/pins';
import { StickerPicker } from './StickerPicker';
import { useMessageEditing } from '../hooks/useMessageEditing';
import { useDraft } from '../hooks/useDraft';
import { draftKey } from '../lib/drafts';
import { useSealedExchange } from '../hooks/useSealedExchange';
import { useCall } from '../hooks/useCall';
import { isEngaged } from '../lib/call/state';
import { useBlockStatus } from '../hooks/useBlocks';
import { blockUser, unblockUser } from '../lib/blocks';
import { reportExcerpt, sendReport } from '../lib/report';
import { BlockedNotice } from './BlockedNotice';
import { ReportModal } from './ReportModal';
import type { MessageKey } from '../lib/i18n';

interface ChatRoomProps {
  session: Session;
  friend: Profile;
  /** Required, not optional: this component cannot send or read a vault
   *  message without a key, and a required prop makes that a type error
   *  instead of a runtime branch. App renders nothing until the key exists. */
  identity: Identity;
  /** A message to land on when the conversation opens, from a search across
   *  all chats. Null every other time — the thread's own default is the
   *  newest message, which is what opening a chat usually means. */
  openAt?: { messageId: string; createdAt: string } | null;
  onBack: () => void;
}

/**
 * One open conversation. Almost everything it does lives in a hook beside it:
 * `useChatThread` owns the messages (and, through it, the outbox, the read
 * receipts and the scroll position), `useMediaSend` the attachments,
 * `usePeerTrust` the peer's key. What is left here is the composer's own
 * state, the modals, and the wiring between them.
 */
/** A stable empty set, so a thread that is not selecting hands its bubbles the
 *  same reference on every render instead of a fresh one. */
const EMPTY_SELECTION: ReadonlySet<string> = new Set();

export function ChatRoom({ session, friend, identity, openAt, onBack }: ChatRoomProps) {
  const me = session.user.id;
  // Your own notes: no peer, so nothing about presence, typing, receipts or
  // notifications applies. Every branch below that mentions `isSelf` exists
  // because the other participant these features describe is you.
  const isSelf = isSelfChat(me, friend.id);
  const nickname = useNickname(friend.id);
  const peerLabel = formatDisplayName(nickname, friend.display_name, isSelf);
  const friendStatus = usePresenceStatus(friend.id);
  const toast = useToast();
  const t = useT();
  const background = useChatBackground(me, { kind: 'peer', peerId: friend.id }, identity);
  const { peerKey, trust, refresh: refreshTrust } = usePeerTrust(friend.id, isSelf);

  // Per conversation, and outside this component: the pane is not remounted
  // when the selected friend changes, so component state would carry a
  // half-typed message into the next person's composer.
  const draft = useDraft(draftKey('peer', friend.id));
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // Docked in the same slot as the search panel, so only one of them is open:
  // two stacked panels would push the thread off a phone screen entirely.
  const [panelOpen, setPanelOpen] = useState(false);
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  const [nicknameOpen, setNicknameOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [askSealedOpen, setAskSealedOpen] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  // Either direction closes the conversation to new writes; see lib/blocks.ts.
  // The self-chat cannot hold a block (`no_self_block`), so it reads 'none'.
  const blockStatus = useBlockStatus(me, friend.id);
  const blocked = blockStatus !== 'none';
  // The message whose "Forward" was chosen, and so the one the picker will
  // copy. Null when the picker is closed.
  const [forwarding, setForwarding] = useState<Message | null>(null);
  /**
   * Messages picked out to be acted on together, by id.
   *
   * Null when nothing is being picked — which is a different state from an
   * empty set: the bar is up while the set is empty, because deselecting the
   * last message is how somebody changes their mind and it should not also
   * take a tap on Cancel.
   */
  const [selectedIds, setSelectedIds] = useState<Set<string> | null>(null);
  /** A bulk forward in the same sheet a single forward uses. */
  const [forwardingMany, setForwardingMany] = useState<Message[] | null>(null);
  /** The one message held at the top of this conversation, or null. Both
   *  participants see the same one — see migration 0048. */
  const [pinned, setPinned] = useState<PinnedMessage | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  // The app's one wake signal — see `lib/connection.ts`. Every fetch beside a
  // subscription keys on it rather than growing wake logic of its own.
  const { generation } = useConnection();
  /** The message whose reactions the sheet is showing, by id rather than by
   *  row: the rows are re-fetched and re-created on every wake, and a captured
   *  one would leave the open sheet showing a frozen list. */
  const [showingReactions, setShowingReactions] = useState<string | null>(null);
  /** The failed queued message whose Discard is awaiting confirmation. */
  const [discarding, setDiscarding] = useState<string | null>(null);
  const composerRef = useRef<ComposerHandle>(null);

  /**
   * The single read boundary. Every fetch and every realtime arrival passes
   * through here to be decrypted once, on the way into state.
   *
   * The peer key is resolved per call rather than held in state on purpose:
   * `peerPublicKey` caches in-module after the first fetch, so this costs one
   * request per peer per session, and there is no window during which rows can
   * arrive before a key-loading effect has settled and render as decrypt
   * failures that a later re-render would have to undo.
   */
  const open = useCallback(
    async (rows: Message[]): Promise<Message[]> =>
      openRows(identity, await peerPublicKey(friend.id), friend.id, rows),
    [identity, friend.id]
  );

  /**
   * The rest of this conversation, fetched into the local mirror when
   * something asks a question of the whole of it.
   *
   * Search, the panel and the export all read the mirror, and the mirror holds
   * what this device has opened — which, without this, is the pages somebody
   * scrolled. A conversation older than a screenful answered those three from
   * its last page and gave no sign it was doing so.
   *
   * Pages are fetched and opened exactly as the thread fetches them; opening
   * is what mirrors them. Only after the identity exists — a page opened
   * without one decrypts to nothing and would be walked again later for
   * nothing.
   */
  const history = useHistoryBackfill({
    conversationId: friend.id,
    ready: identity !== null,
    pageSize: PAGE_SIZE,
    fetchOlder: useCallback(
      async (cursor) => {
        const page = cursor
          ? await fetchOlderPage(me, friend.id, cursor)
          : await fetchLatestPage(me, friend.id);
        await open(page);
        // Sealed as well as opened. Opening mirrors the plaintext search reads;
        // this keeps the row the thread can actually render — with its
        // attachment, its reply and its reactions — so the walk that makes a
        // conversation searchable also makes it scrollable with no signal.
        await putSealedRows(friend.id, page);
        return page;
      },
      [me, friend.id, open]
    ),
  });

  // Opening either panel is the question being asked, so that is where the
  // walk starts. `ensure` joins a run already going rather than starting a
  // second one.
  // `history.ensure`, not `history`: the hook returns a fresh object every
  // render, and depending on it would re-fire this on each one.
  const startHistory = history.ensure;
  useEffect(() => {
    if (searchOpen || panelOpen) void startHistory();
  }, [searchOpen, panelOpen, startHistory]);

  /** Composer housekeeping shared by both send paths: the message is on its
   *  way, so the box empties and takes focus back. */
  function clearComposer() {
    draft.clear();
    setReplyingTo(null);
    composerRef.current?.focus();
  }

  const thread = useChatThread({
    me,
    peerId: friend.id,
    identity,
    isSelf,
    open,
    onError: toast.error,
    onQueued: clearComposer,
  });

  // Land on the message a search result named, once, after the first page is
  // in. Keyed on the target rather than run on mount: opening the same chat at
  // a different message is a second jump, and re-running on every render would
  // fight the reader for the scroll position for as long as the chat is open.
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    if (!openAt) {
      jumped.current = null;
      return;
    }
    if (jumped.current === openAt.messageId) return;
    // Wait for the first page. `jumpToMessage` pages back from what is loaded,
    // and run against nothing it would page back through the whole history to
    // reach a message the very first request was about to deliver.
    if (thread.messages.length === 0) return;
    jumped.current = openAt.messageId;
    void thread.jumpToMessage(openAt.messageId, openAt.createdAt);
    // `thread` is rebuilt every render; only the two values this actually
    // depends on belong here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAt, thread.messages.length]);

  const media = useMediaSend({
    me,
    target: { kind: 'peer', peerId: friend.id, isSelf },
    identity,
    onStaged: () => composerRef.current?.focus(),
    onSent: clearComposer,
    onError: toast.error,
  });

  const call = useCall();

  const editing = useMessageEditing({ me, peerId: friend.id, identity, onError: toast.error });

  // The drawer is per account, not per conversation: it is fetched once here
  // and its decrypted bytes are cached module-side, so opening a second chat
  // does not re-download it.
  const stickers = useStickers(me, identity);

  // Sealed exchanges live beside the thread rather than in it: the answers are
  // a different table with a different visibility rule, released by policy
  // only once this account has committed one of its own.
  const sealed = useSealedExchange({
    me,
    peerId: friend.id,
    identity,
    isSelf,
    messages: thread.messages,
    onError: toast.error,
  });
  // Read out once so the composer's save callback closes over a `string` rather
  // than the nullable field.
  const editingId = editing.editingId;

  const { byMessage, toggle } = useReactions(
    me,
    thread.messages.map((m) => m.id)
  );
  // Quoted messages, including the ones that are older than the loaded window.
  const replyTargets = useReplyTargets(me, friend.id, thread.messages, open);

  // Attachments this device pinned, so a row the sender has since trimmed is
  // rendered from the kept bytes instead of as the placeholder their device
  // wrote over it. Only the thread is given the restored list: a forward or a
  // reply quote would be describing the server's copy, which really is gone.
  const pins = usePins();
  /**
   * Deletes that have been asked for but not yet written.
   *
   * A delete is the one action in a conversation with no way back — the row
   * becomes a tombstone on both phones and the body is gone from the mirror —
   * so it is held for as long as its toast is up. The bubble goes immediately,
   * because a grace period nobody can see is not one, and the write happens
   * when the toast expires. Undo simply never lets it start.
   */
  const [deleting, setDeleting] = useState<Map<string, Message>>(() => new Map());

  const shown = useMemo(
    () =>
      restorePinned(thread.messages, pins).filter((m) => !deleting.has(m.id)),
    [thread.messages, pins, deleting]
  );

  function requestDelete(msg: Message) {
    setDeleting((prev) => new Map(prev).set(msg.id, msg));
    const forget = () =>
      setDeleting((prev) => {
        const next = new Map(prev);
        next.delete(msg.id);
        return next;
      });
    toast.offer(t('message.deleteToast'), { label: t('common.undo'), onAct: forget }, () => {
      forget();
      void editing.deleteMessage(msg);
    });
  }
  // A delete-for-everyone is the sender asking for the message to be gone, and
  // a pin is not a way around that: the kept bytes go with it. Watched here
  // rather than in the delete handler because the delete usually happens on the
  // other phone and arrives as an update.
  useEffect(() => {
    if (pins.size === 0) return;
    for (const msg of thread.messages) {
      if (msg.deleted_at && pins.has(msg.id)) void unpinMedia(msg.id).catch(() => {});
    }
  }, [thread.messages, pins]);

  // A queued send carries the id its server row will have, so the two lists
  // can name the same message for the moment between the row being merged and
  // the queue entry being retired. The authoritative row wins; rendering both
  // would paint the message twice (and hand React two children with the same
  // key).
  // The one shortcut a conversation owns. Ctrl/⌘+F means "search what is in
  // front of me" everywhere else, and it is deliberately allowed to fire from
  // inside the composer — see `lib/shortcuts.ts`.
  const chatExport = useExportChat({
    conversationId: friend.id,
    title: peerLabel,
    me,
    meLabel: t('common.you'),
    nameFor: () => peerLabel,
    // A transcript missing everything older than the last screenful is not a
    // transcript, and the file gives no hint that it is short — so the export
    // waits for the walk rather than writing what happens to be mirrored.
    prepare: history.ensure,
  });

  /** The picked messages, resolved against what the thread is still holding —
   *  a message deleted on the other phone while a selection is open must not
   *  be counted in the bar and then quietly do nothing. */
  const picked = useMemo(
    () => (selectedIds ? shown.filter((m) => selectedIds.has(m.id)) : []),
    [selectedIds, shown]
  );
  const powers = useMemo(
    () =>
      selectionPowers(
        picked.map((m) => ({
          id: m.id,
          isOwn: m.user_id === me,
          forwardable: isForwardable(m),
        }))
      ),
    [picked, me]
  );

  function deleteSelected() {
    // Through the same grace period a single delete gets, once for the set:
    // the bubbles go now and the writes start when the offer expires.
    const doomed = picked;
    setSelectedIds(null);
    setDeleting((prev) => {
      const next = new Map(prev);
      for (const msg of doomed) next.set(msg.id, msg);
      return next;
    });
    const forget = () =>
      setDeleting((prev) => {
        const next = new Map(prev);
        for (const msg of doomed) next.delete(msg.id);
        return next;
      });
    toast.offer(
      t('message.deletedMany', { count: doomed.length }),
      { label: t('common.undo'), onAct: forget },
      () => {
        forget();
        for (const msg of doomed) void editing.deleteMessage(msg);
      }
    );
  }

  // Re-read whenever the socket is rebuilt, like every other fetch beside a
  // subscription: `generation` is the app's one wake signal and a pin set on
  // another device while this one was asleep arrives with it.
  useEffect(() => {
    let alive = true;
    void loadConversationPin(me, friend.id)
      .then((row) => {
        if (alive) setPinned(row);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [me, friend.id, generation]);

  useEffect(() => {
    const channel = supabase
      .channel(`chat-pin:${friend.id}:${generation}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversation_pins' },
        () => {
          // RLS scopes this stream to conversations this account is in, and a
          // pin is one row — cheaper to re-read than to reassemble from a
          // payload whose DELETE half carries only the key.
          void loadConversationPin(me, friend.id)
            .then(setPinned)
            .catch(() => {});
        }
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [me, friend.id, generation]);

  /** The pinned message as one line, when this device is holding it. */
  const pinnedSnippet = useMemo(() => {
    if (!pinned) return null;
    const row = thread.messages.find((m) => m.id === pinned.messageId);
    return row ? messageSnippet(row) : null;
  }, [pinned, thread.messages]);

  async function togglePin(msg: Message) {
    setPinBusy(true);
    try {
      if (pinned?.messageId === msg.id) await unpinConversationMessage(me, friend.id);
      else await pinConversationMessage(friend.id, msg.id);
      setPinned(await loadConversationPin(me, friend.id));
    } catch {
      toast.error(t('pin.failed'));
    } finally {
      setPinBusy(false);
    }
  }

  /**
   * How loudly this conversation arrives.
   *
   * Read from the flag store rather than held here: the chat list writes the
   * same flags and mirrors them to the notification extension, and a second
   * copy in this component would be the one that went stale.
   */
  const [alertLevel, setAlertLevelState] = useState<AlertLevel | null>(null);
  useEffect(() => {
    let alive = true;
    const read = () =>
      void loadChatFlags().then((flags) => {
        if (alive) setAlertLevelState(alertLevelFor(friend.id, flags));
      });
    read();
    // The flags are also written from the chat list, which does not share a
    // subtree with this — `subscribeChatFlags` is how the two stay in step.
    const stop = subscribeChatFlags(read);
    return () => {
      alive = false;
      stop();
    };
  }, [friend.id]);

  async function changeAlertLevel(level: AlertLevel | null) {
    try {
      await setAlertLevel(friend.id, 'peer', level);
    } catch {
      toast.error(t('alerts.failed'));
    }
  }

  async function runExport() {
    if (chatExport.busy) return;
    const written = await chatExport.run();
    if (written === null) toast.error(t('chat.exportFailed'));
    else toast.success(t('chat.exported', { count: written }));
  }

  useShortcut((shortcut) => {
    if (shortcut !== 'search-chat') return false;
    setPanelOpen(false);
    setSearchOpen(true);
    return true;
  });

  const merged = new Set(thread.messages.map((m) => m.id));
  const queued = thread.outbox.pending.filter((m) => !merged.has(m.id));

  async function setBlocked(on: boolean): Promise<boolean> {
    setBlockBusy(true);
    const ok = on ? await blockUser(me, friend.id) : await unblockUser(me, friend.id);
    setBlockBusy(false);
    if (!ok) toast.error(t('block.failed'));
    else toast.success(t(on ? 'block.done' : 'block.undone', { name: peerLabel }));
    return ok;
  }

  async function submitReport(
    reason: string,
    includeMessages: boolean,
    alsoBlock: boolean
  ): Promise<boolean> {
    try {
      const ticket = await sendReport(
        friend.id,
        reason,
        includeMessages ? reportExcerpt(thread.messages) : []
      );
      toast.success(t('report.sent', { ticket: `#${ticket}` }));
    } catch (error) {
      toast.error(t((error as Error).message as MessageKey));
      return false;
    }
    // After the report, not before: a block that landed first and a report
    // that then failed would leave the person blocked with nothing filed.
    if (alsoBlock) await setBlocked(true);
    return true;
  }

  async function handleSend() {
    // Fired here rather than inside the two send paths, and before either
    // runs: the confirmation the thumb wants is "I registered that", not "the
    // server has it", and waiting for the round trip would land it after the
    // bubble is already on screen.
    void tapSend();
    const replyToId = replyingTo?.id ?? null;
    if (media.staged.length) {
      await media.send(draft.value.trim(), replyToId);
    } else {
      await thread.outbox.send(draft.value.trim(), replyToId);
    }
  }

  return (
    <div className="flex flex-col h-full bg-base-200/50">
      <ChatHeader
        friend={friend}
        peerLabel={peerLabel}
        nickname={nickname}
        isSelf={isSelf}
        trust={trust}
        peerKey={peerKey}
        friendStatus={friendStatus}
        searchOpen={searchOpen}
        onBack={onBack}
        onOpenProfile={() => setProfileOpen(true)}
        onOpenNickname={() => setNicknameOpen(true)}
        onToggleSearch={() => {
          setPanelOpen(false);
          setSearchOpen((open) => !open);
        }}
        onOpenVerify={() => setVerifyOpen(true)}
        onOpenBackground={() => setBackgroundOpen(true)}
        onExport={() => void runExport()}
        alertLevel={alertLevel}
        onSetAlertLevel={(level) => void changeAlertLevel(level)}
        onAskSealed={() => setAskSealedOpen(true)}
        onOpenPanel={() => {
          setSearchOpen(false);
          setPanelOpen(true);
        }}
        timer={thread.timer}
        onSetTimer={(seconds) => void thread.changeTimer(seconds)}
        onCall={(kind) => call.placeCall(friend, kind)}
        // A call is sealed to the peer's published key exactly like a message,
        // so no key means nothing to dial. `isEngaged` keeps the button from
        // starting a second call over a live one, and a block closes calls
        // like everything else (`call-ring` refuses them too).
        canCall={!!peerKey && !isEngaged(call.state) && !blocked}
        blockStatus={blockStatus}
        onBlock={() => setConfirmBlock(true)}
        onUnblock={() => void setBlocked(false)}
        onReport={() => setReportOpen(true)}
      />

      {confirmBlock && (
        <Modal
          title={t('block.confirmTitle', { name: peerLabel })}
          onClose={() => (blockBusy ? undefined : setConfirmBlock(false))}
          actions={
            <>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setConfirmBlock(false)}
                disabled={blockBusy}
              >
                {t('common.cancel')}
              </button>
              <button
                className="btn btn-error btn-sm"
                disabled={blockBusy}
                onClick={() =>
                  void setBlocked(true).then((ok) => {
                    if (ok) setConfirmBlock(false);
                  })
                }
              >
                {blockBusy ? (
                  <span className="loading loading-spinner loading-xs" />
                ) : (
                  t('chat.block')
                )}
              </button>
            </>
          }
        >
          <p className="text-body text-strong">{t('block.confirmBody')}</p>
        </Modal>
      )}

      {reportOpen && (
        <ReportModal
          peerLabel={peerLabel}
          messageCount={reportExcerpt(thread.messages).length}
          alreadyBlocked={blockStatus === 'byMe' || blockStatus === 'both'}
          onSend={submitReport}
          onClose={() => setReportOpen(false)}
        />
      )}

      {verifyOpen && peerKey && (
        <VerifyContact
          peerId={friend.id}
          peerLabel={peerLabel}
          myPublic={identity.boxPublic}
          theirPublic={peerKey}
          onVerified={() => {
            void tapSuccess();
            refreshTrust();
          }}
          onClose={() => setVerifyOpen(false)}
        />
      )}

      {backgroundOpen && (
        <ChatBackgroundModal
          url={background.url}
          busy={background.busy}
          onPick={background.setBackground}
          onRemove={background.removeBackground}
          onClose={() => setBackgroundOpen(false)}
        />
      )}

      {showingReactions && (
        <ReactionSheet
          reactions={byMessage.get(showingReactions) ?? []}
          me={me}
          // Two people, so the resolver is a comparison rather than a lookup.
          // `ReactionSheet` renders your own as "You" before it ever asks.
          nameFor={() => peerLabel}
          onClose={() => setShowingReactions(null)}
        />
      )}

      {forwarding && (
        <ForwardModal
          me={me}
          sources={[peerSource(forwarding)]}
          preview={messageSnippet(forwarding)}
          fromKey={friend.id}
          identity={identity}
          onClose={() => setForwarding(null)}
        />
      )}

      {forwardingMany && (
        <ForwardModal
          me={me}
          // Oldest first, so they arrive in the order the conversation had
          // them rather than the order they happened to be tapped in.
          sources={[...forwardingMany]
            .sort((a, b) => a.created_at.localeCompare(b.created_at))
            .map(peerSource)}
          preview={t('selection.count', { count: forwardingMany.length })}
          fromKey={friend.id}
          identity={identity}
          onClose={() => {
            setForwardingMany(null);
            setSelectedIds(null);
          }}
        />
      )}

      {askSealedOpen && (
        <AskSealedModal
          peerLabel={peerLabel}
          busy={sealed.busy.size > 0}
          onAsk={(question, answer) => {
            void tapSend();
            void sealed.ask(question, answer).then((row) => {
              if (row) setAskSealedOpen(false);
            });
          }}
          onClose={() => setAskSealedOpen(false)}
        />
      )}

      {profileOpen && (
        <ProfileCard
          userId={friend.id}
          fallback={friend}
          nickname={nickname}
          isSelf={isSelf}
          trust={trust}
          friendStatus={friendStatus}
          onEditNickname={() => setNicknameOpen(true)}
          onClose={() => setProfileOpen(false)}
        />
      )}

      {nicknameOpen && (
        <NicknameModal
          me={me}
          peerId={friend.id}
          identity={identity}
          display_name={friend.display_name}
          isSelf={isSelf}
          onClose={() => setNicknameOpen(false)}
        />
      )}

      {pinned && (
        <PinnedBanner
          snippet={pinnedSnippet}
          by={pinned.pinnedBy === me ? t('common.you') : peerLabel}
          busy={pinBusy}
          onJump={() => void thread.jumpToMessage(pinned.messageId, pinned.pinnedAt)}
          onUnpin={() => void togglePin({ id: pinned.messageId } as Message)}
        />
      )}

      {searchOpen && (
        <ConversationSearch
          key={friend.id}
          peerId={friend.id}
          me={me}
          peerLabel={peerLabel}
          isSelf={isSelf}
          loadingHistory={history.running}
          historyRevision={history.fetched}
          onJump={(messageId, createdAt) => {
            setSearchOpen(false);
            void thread.jumpToMessage(messageId, createdAt);
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {panelOpen && (
        <ConversationPanel
          key={friend.id}
          peerId={friend.id}
          me={me}
          peerLabel={peerLabel}
          isSelf={isSelf}
          // Re-read as the walk lands pages, not only when a message arrives:
          // the panel is scanning the mirror, and the mirror is still filling.
          revision={thread.messages.length + history.fetched}
          loadingHistory={history.running}
          open={open}
          onJump={(messageId, createdAt) => {
            setPanelOpen(false);
            void thread.jumpToMessage(messageId, createdAt);
          }}
          onClose={() => setPanelOpen(false)}
        />
      )}

      {/* The conversation's pictures, so the viewer opened from any one of
          them can step to the next without closing (`lib/gallery.ts`). */}
      <GalleryProvider messages={shown}>
        <MessageThread
          me={me}
          selecting={selectedIds !== null}
          selectedIds={selectedIds ?? EMPTY_SELECTION}
          onStartSelecting={(msg) => setSelectedIds(new Set([msg.id]))}
          onToggleSelected={(msg) =>
            setSelectedIds((current) => toggleSelected(current ?? new Set(), msg.id))
          }
          peerLabel={peerLabel}
          // One person is on the other side, and the bubble's own side already
          // says which. Printing their name above every run of messages spent
          // a line of the thread on something the reader knew before they
          // opened the conversation — it is the group thread that needs it.
          nameFor={() => peerLabel}
          showSenderNames={false}
          isSelf={isSelf}
          messages={shown}
          queued={queued}
          typingLabel={
            thread.friendTyping && !isSelf && !blocked
              ? t('thread.typing', { name: peerLabel })
              : null
          }
          hasMore={thread.hasMore}
          loadingOlder={thread.loadingOlder}
          peerReceipt={thread.peerReceipt}
          unreadDividerId={thread.unreadDividerId}
          reactions={byMessage}
          replyTargets={replyTargets}
          scroll={thread.scroll}
          backgroundUrl={background.url}
          timerChange={describeTimerChange(thread.timer, me, peerLabel)}
          editingId={editing.editingId}
          editingText={editing.editingText}
          sealedAnswers={sealed.answers}
          sealedBusy={sealed.busy}
          onAnswerSealed={(promptId, text) => {
            void tapSend();
            void sealed.answer(promptId, text);
          }}
          isAlreadySeen={thread.isAlreadySeen}
          onLoadOlder={() => void thread.loadOlder()}
          onToggleReaction={toggle}
          onReply={setReplyingTo}
          onForward={setForwarding}
          onShowReactions={(msg) => setShowingReactions(msg.id)}
          pinnedId={pinned?.messageId ?? null}
          onTogglePin={(msg) => void togglePin(msg)}
          onJumpToReplied={thread.jumpToRepliedMessage}
          onEditingTextChange={editing.setEditingText}
          onSaveEdit={(id) => void editing.saveEdit(id)}
          onCancelEdit={editing.cancelEdit}
          onStartEdit={editing.startEdit}
          onDelete={requestDelete}
          onRetryQueued={(id) => void thread.outbox.retry(id)}
          onDiscardQueued={setDiscarding}
        />
      </GalleryProvider>

      {/* Confirmed, unlike every other pending-message transition: this is the
          only path in the app that destroys an unsent body, and the text on
          screen is the sole copy of it. */}
      {discarding && (
        <Modal
          title={t('outbox.discardTitle')}
          onClose={() => setDiscarding(null)}
          actions={
            <>
              <button className="btn btn-ghost btn-sm" onClick={() => setDiscarding(null)}>
                {t('chatList.keep')}
              </button>
              <button
                className="btn btn-error btn-sm"
                onClick={() => {
                  void thread.outbox.discard(discarding);
                  setDiscarding(null);
                }}
              >
                {t('outbox.discard')}
              </button>
            </>
          }
        >
          <p className="text-body text-muted">{t('outbox.discardBody')}</p>
        </Modal>
      )}

      {/* While messages are being picked out, the bar stands in for the
          composer rather than sitting above it: writing and selecting are two
          modes, and a text field under a "3 selected" bar invites typing into
          a conversation that is not listening. */}
      {selectedIds !== null ? (
        <div className="flex items-center gap-2 border-t border-hairline bg-base-100 p-3 pb-[calc(0.75rem+var(--safe-bottom))] sm:p-4 sm:pb-[calc(1rem+var(--safe-bottom))]">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setSelectedIds(null)}
          >
            {t('selection.cancel')}
          </button>
          <span className="flex-1 truncate text-body font-medium">
            {t('selection.count', { count: powers.count })}
          </span>
          <button
            className="btn btn-ghost btn-sm btn-square"
            disabled={!powers.canForward}
            onClick={() => setForwardingMany(picked)}
            title={powers.canForward ? t('message.forward') : t('selection.mixedForward')}
            aria-label={t('message.forward')}
          >
            <CornerUpRight className="h-4 w-4" />
          </button>
          {/* Absent, not greyed, when the selection holds somebody else's
              message. A disabled bin is the app offering to delete and then
              refusing, and the only thing it can be read as is the rule being
              arbitrary — whereas you cannot delete what you did not write, on
              a server that keeps no copy for you to reach. The count line
              above it is what changes as the selection does. */}
          {powers.canDelete && (
            <button
              className="btn btn-ghost btn-sm btn-square text-error"
              onClick={deleteSelected}
              title={t('common.delete')}
              aria-label={t('common.delete')}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      ) : blockStatus !== 'none' ? (
        // Before the key-change notice: a verified key does not reopen a
        // conversation somebody has closed.
        <BlockedNotice
          status={blockStatus}
          peerLabel={peerLabel}
          busy={blockBusy}
          onUnblock={() => void setBlocked(false)}
        />
      ) : trust === 'changed' ? (
        <KeyChangedNotice peerKey={peerKey} onVerify={() => setVerifyOpen(true)} />
      ) : (
        <Composer
          ref={composerRef}
          value={draft.value}
          onChange={(v) => {
            draft.setValue(v);
            thread.notifyTyping();
          }}
          onSend={handleSend}
          onStageFile={media.stage}
          staged={media.staged}
          onUnstage={media.unstage}
          onClearStaged={media.clearStaged}
          sentCount={media.sentCount}
          onError={toast.error}
          sending={thread.outbox.sending}
          uploading={media.uploading}
          replyingTo={
            replyingTo
              ? {
                  display_name: peerLabel,
                  self: replyingTo.user_id === me,
                  snippet: messageSnippet(replyingTo),
                }
              : null
          }
          onCancelReply={() => setReplyingTo(null)}
          editing={
            editingId
              ? {
                  canSave: editing.canSave,
                  saving: editing.savingEdit,
                  onSave: () => void editing.saveEdit(editingId),
                  onCancel: editing.cancelEdit,
                }
              : null
          }
          stickers={
            <StickerPicker
              drawer={stickers}
              onSelect={(sticker) => {
                // Sent on the tap, with no caption and no staging step. A
                // sticker is chosen and sent in one gesture; routing it through
                // the preview strip would put a Send button between the two.
                void media.sendSticker(sticker, replyingTo?.id ?? null);
                setReplyingTo(null);
              }}
              onError={toast.error}
            />
          }
        />
      )}
    </div>
  );
}
