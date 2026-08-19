// Where the message list is looking, and everything that moves it.
//
// Kept apart from the thread's data because the two answer different
// questions: `useChatThread` decides which messages exist, this decides
// whether the view follows them.

import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { Message, PendingMessage } from '../lib/types';
import { prefersReducedMotion } from '../lib/motion';

/** How long a jumped-to message's ring highlight stays visible. */
const HIGHLIGHT_MS = 1200;

/** Distance from the bottom, in px, still counted as "at the bottom". */
const AT_BOTTOM_SLACK_PX = 120;

export interface ThreadScroll {
  listRef: RefObject<HTMLDivElement>;
  bottomRef: RefObject<HTMLDivElement>;
  /** Whether the list is scrolled (near) to the bottom. The ref is the source
   *  of truth logic reads synchronously; `atBottom` is its render-facing
   *  mirror, and exists only to gate the jump-to-latest button. */
  atBottomRef: MutableRefObject<boolean>;
  atBottom: boolean;
  /** Inbound messages that arrived while scrolled away from the bottom, shown
   *  on the jump-to-latest button. Reset on return to the bottom. */
  newSinceScroll: number;
  /** The message a search jump just landed on — briefly ringed, then cleared. */
  highlightId: string | null;
  /** Set before a state update that must not move the view: paging older
   *  messages in, where the browser is about to be told where to look. */
  skipAutoScroll: MutableRefObject<boolean>;
  handleListScroll: () => void;
  scrollToLatest: () => void;
  scrollToMessage: (id: string) => void;
  /** Count arrivals the reader has scrolled away from. A no-op at the bottom,
   *  where the messages land in view without needing the button. */
  countArrivals: (n: number) => void;
  /** Snap the position bookkeeping back to "at the bottom, nothing missed",
   *  for a thread that is being rebuilt from its newest page. */
  resetPosition: () => void;
}

interface ThreadScrollOptions {
  /** Resets the whole view when it changes: the jump-to-latest button, its
   *  counter and any in-flight highlight belong to the conversation that built
   *  them. */
  peerId: string;
  me: string;
  messages: Message[];
  pending: PendingMessage[];
  /** The peer's typing bubble, which is part of the thread's height and so
   *  part of what "the bottom" means. */
  peerTyping: boolean;
}

export function useThreadScroll({
  peerId,
  me,
  messages,
  pending,
  peerTyping,
}: ThreadScrollOptions): ThreadScroll {
  const [atBottom, setAtBottom] = useState(true);
  const [newSinceScroll, setNewSinceScroll] = useState(0);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const skipAutoScroll = useRef(false);
  // Reset per conversation: the first scroll into a chat should not animate.
  const didFirstScroll = useRef(false);
  // Pending clear for `highlightId`, tracked so a second jump landing before
  // the first flash finishes can cancel and restart it cleanly.
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Previous render's `messages` identity and `pending` length, used by the
  // auto-scroll effect below to tell an *addition* to `pending` (scroll-worthy)
  // apart from a *removal* (not) without adding a second effect.
  const prevMessagesRef = useRef<Message[]>(messages);
  const prevPendingLenRef = useRef(0);

  function clearHighlightTimer() {
    if (highlightTimer.current) {
      clearTimeout(highlightTimer.current);
      highlightTimer.current = null;
    }
  }

  function resetPosition() {
    atBottomRef.current = true;
    setAtBottom(true);
    setNewSinceScroll(0);
  }

  useEffect(() => {
    didFirstScroll.current = false;
    resetPosition();
    setHighlightId(null);
    clearHighlightTimer();
    return clearHighlightTimer;
  }, [peerId]);

  useEffect(() => {
    const messagesChanged = messages !== prevMessagesRef.current;
    const pendingGrew = pending.length > prevPendingLenRef.current;
    prevMessagesRef.current = messages;
    prevPendingLenRef.current = pending.length;

    if (skipAutoScroll.current) {
      skipAutoScroll.current = false;
      return;
    }
    // `pending` only ever shrinks here from a successful flush or a
    // MAX_ATTEMPTS drop — cleanup of a bubble already on screen, not
    // something new to look at. Scrolling for it would yank a user reading
    // history back to the bottom for no reason (worst case, right as they
    // also get an error toast for the drop). Skip unless this run was
    // actually caused by a `messages` change or a `pending` addition.
    if (!messagesChanged && !pendingGrew) return;
    // Stick to the bottom only when the user is already there, or when the
    // newest message is one they just sent — otherwise leave their scroll be.
    // `pending` is in the dep array too: an optimistic send appends there,
    // not to `messages`, and it's still your own newest message.
    const last = pending[pending.length - 1] ?? messages[messages.length - 1];
    const isMine = last?.user_id === me;
    if (isMine || atBottomRef.current) {
      // Jump straight to the bottom on the first paint of a conversation —
      // animating a fresh 30-message list scrolls visibly past all of it.
      // `behavior: 'smooth'` passed explicitly here always wins over the
      // CSS reduced-motion rule in index.css, so that preference has to be
      // applied on this side too.
      bottomRef.current?.scrollIntoView({
        behavior: didFirstScroll.current && !prefersReducedMotion() ? 'smooth' : 'auto',
      });
      didFirstScroll.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, pending]);

  // The typing bubble appearing grows the list by its own height. A reader
  // sitting at the bottom would otherwise have it land under the fold, which
  // for an indicator is the same as not showing it at all. Only on the way in:
  // its removal shrinks the list back, and scrolling for that would yank
  // somebody who had meanwhile started reading upwards.
  useEffect(() => {
    if (!peerTyping || !atBottomRef.current) return;
    bottomRef.current?.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [peerTyping]);

  function handleListScroll() {
    const el = listRef.current;
    if (!el) return;
    const nowAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_SLACK_PX;
    atBottomRef.current = nowAtBottom;
    setAtBottom(nowAtBottom);
    if (nowAtBottom) setNewSinceScroll(0);
  }

  // The counter drops here rather than waiting for the smooth scroll's
  // trailing scroll event, so the badge doesn't linger through the animation.
  function scrollToLatest() {
    bottomRef.current?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    setNewSinceScroll(0);
  }

  /** Scroll a rendered bubble into view and ring it briefly so a search
   *  result reads as "found", not just silently present on screen. */
  function scrollToMessage(id: string) {
    // Same reduced-motion override as the auto-scroll effect above: a
    // `behavior: 'smooth'` passed here would otherwise animate regardless
    // of the OS setting.
    document.getElementById(`msg-${id}`)?.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'center',
    });
    clearHighlightTimer();
    setHighlightId(id);
    highlightTimer.current = setTimeout(() => {
      setHighlightId(null);
      highlightTimer.current = null;
    }, HIGHLIGHT_MS);
  }

  function countArrivals(n: number) {
    if (!atBottomRef.current) setNewSinceScroll((count) => count + n);
  }

  return {
    listRef,
    bottomRef,
    atBottomRef,
    atBottom,
    newSinceScroll,
    highlightId,
    skipAutoScroll,
    handleListScroll,
    scrollToLatest,
    scrollToMessage,
    countArrivals,
    resetPosition,
  };
}
