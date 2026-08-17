import { useCallback, useRef, useState } from 'react';
import { Session } from '@supabase/supabase-js';
import { Message, Profile } from '../lib/types';
import { isSelfChat, messageSnippet } from '../lib/conversation';
import { describeTimerChange } from '../lib/disappearing';
import { openRows } from '../lib/sealed-body';
import { peerPublicKey } from '../lib/peer-keys';
import type { Identity } from '../lib/crypto/keys';
import { formatDisplayName, useNickname } from '../lib/nicknames';
import { tapSend, tapSuccess } from '../lib/haptics';
import { Composer, ComposerHandle } from './Composer';
import { ConversationSearch } from './ConversationSearch';
import { ConversationPanel } from './ConversationPanel';
import { ChatBackgroundModal } from './ChatBackgroundModal';
import { NicknameModal } from './NicknameModal';
import { ForwardModal } from './ForwardModal';
import { AskSealedModal } from './AskSealedModal';
import { VerifyContact } from './VerifyContact';
import { ChatHeader } from './ChatHeader';
import { MessageThread } from './MessageThread';
import { KeyChangedNotice } from './KeyChangedNotice';
import { useReactions } from '../hooks/useReactions';
import { useReplyTargets } from '../hooks/useReplyTargets';
import { useChatBackground } from '../hooks/useChatBackground';
import { usePresenceStatus } from '../hooks/usePresence';
import { useToast } from '../hooks/useToast';
import { useChatThread } from '../hooks/useChatThread';
import { usePeerTrust } from '../hooks/usePeerTrust';
import { useMediaSend } from '../hooks/useMediaSend';
import { useStickers } from '../hooks/useStickers';
import { StickerPicker } from './StickerPicker';
import { useMessageEditing } from '../hooks/useMessageEditing';
import { useDraft } from '../hooks/useDraft';
import { draftKey } from '../lib/drafts';
import { useSealedExchange } from '../hooks/useSealedExchange';
import { useCall } from '../hooks/useCall';
import { isEngaged } from '../lib/call/state';

interface ChatRoomProps {
  session: Session;
  friend: Profile;
  /** Required, not optional: this component cannot send or read a vault
   *  message without a key, and a required prop makes that a type error
   *  instead of a runtime branch. App renders nothing until the key exists. */
  identity: Identity;
  onBack: () => void;
}

/**
 * One open conversation. Almost everything it does lives in a hook beside it:
 * `useChatThread` owns the messages (and, through it, the outbox, the read
 * receipts and the scroll position), `useMediaSend` the attachments,
 * `usePeerTrust` the peer's key. What is left here is the composer's own
 * state, the modals, and the wiring between them.
 */
export function ChatRoom({ session, friend, identity, onBack }: ChatRoomProps) {
  const me = session.user.id;
  // Your own notes: no peer, so nothing about presence, typing, receipts or
  // notifications applies. Every branch below that mentions `isSelf` exists
  // because the other participant these features describe is you.
  const isSelf = isSelfChat(me, friend.id);
  const nickname = useNickname(friend.id);
  const peerLabel = formatDisplayName(nickname, friend.display_name, isSelf);
  const friendStatus = usePresenceStatus(friend.id);
  const toast = useToast();
  const background = useChatBackground(me, friend.id, identity);
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
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [askSealedOpen, setAskSealedOpen] = useState(false);
  // The message whose "Forward" was chosen, and so the one the picker will
  // copy. Null when the picker is closed.
  const [forwarding, setForwarding] = useState<Message | null>(null);
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

  // A queued send carries the id its server row will have, so the two lists
  // can name the same message for the moment between the row being merged and
  // the queue entry being retired. The authoritative row wins; rendering both
  // would paint the message twice (and hand React two children with the same
  // key).
  const merged = new Set(thread.messages.map((m) => m.id));
  const queued = thread.outbox.pending.filter((m) => !merged.has(m.id));

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
        friendTyping={thread.friendTyping}
        searchOpen={searchOpen}
        onBack={onBack}
        onOpenNickname={() => setNicknameOpen(true)}
        onToggleSearch={() => {
          setPanelOpen(false);
          setSearchOpen((open) => !open);
        }}
        onOpenVerify={() => setVerifyOpen(true)}
        onOpenBackground={() => setBackgroundOpen(true)}
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
        // starting a second call over a live one.
        canCall={!!peerKey && !isEngaged(call.state)}
      />

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

      {forwarding && (
        <ForwardModal
          me={me}
          msg={forwarding}
          fromPeerId={friend.id}
          identity={identity}
          onClose={() => setForwarding(null)}
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

      {nicknameOpen && (
        <NicknameModal
          me={me}
          peerId={friend.id}
          display_name={friend.display_name}
          isSelf={isSelf}
          onClose={() => setNicknameOpen(false)}
        />
      )}

      {searchOpen && (
        <ConversationSearch
          key={friend.id}
          peerId={friend.id}
          me={me}
          peerLabel={peerLabel}
          isSelf={isSelf}
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
          revision={thread.messages.length}
          onJump={(messageId, createdAt) => {
            setPanelOpen(false);
            void thread.jumpToMessage(messageId, createdAt);
          }}
          onClose={() => setPanelOpen(false)}
        />
      )}

      <MessageThread
        me={me}
        peerLabel={peerLabel}
        isSelf={isSelf}
        messages={thread.messages}
        queued={queued}
        hasMore={thread.hasMore}
        loadingOlder={thread.loadingOlder}
        peerReceipt={thread.peerReceipt}
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
        onJumpToReplied={thread.jumpToRepliedMessage}
        onEditingTextChange={editing.setEditingText}
        onSaveEdit={(id) => void editing.saveEdit(id)}
        onCancelEdit={editing.cancelEdit}
        onStartEdit={editing.startEdit}
        onDelete={(msg) => void editing.deleteMessage(msg)}
      />

      {/* Input, unless the peer's key has changed under us. */}
      {trust === 'changed' ? (
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
                  display_name: replyingTo.user_id === me ? 'yourself' : peerLabel,
                  snippet: messageSnippet(replyingTo),
                }
              : null
          }
          onCancelReply={() => setReplyingTo(null)}
          editing={
            editingId
              ? {
                  canSave: editing.editingText.trim().length > 0,
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
