import { useT } from '../hooks/useT';

/**
 * The peer is typing, drawn where what they type will land — a bubble at the
 * tail of the thread rather than a line in the header.
 *
 * The header version replaced the presence line while it showed, so a status
 * that is meant to be steady blinked between "online" and "typing" for as long
 * as somebody was writing. Here the two are separate things in separate
 * places, and the indicator sits directly above the next message.
 */
export function TypingIndicator({ peerLabel }: { peerLabel: string }) {
  const t = useT();

  return (
    // Announced once as a sentence, not as three animating dots: the visible
    // part is decoration, and a screen reader has no use for it.
    <div className="flex items-start mt-3" aria-live="polite" aria-atomic="true">
      <span className="sr-only">{t('thread.typing', { name: peerLabel })}</span>
      {/* The peer bubble's own geometry and fill, minus the padding a line of
          text needs — the dots are the content, and a text-sized box around
          them reads as an empty message. */}
      <div
        className="flex items-center gap-1 px-3.5 py-3 rounded-2xl rounded-bl-md bg-neutral text-neutral-content shadow-[0_1px_2px_rgba(0,0,0,0.28)]"
        aria-hidden="true"
      >
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </div>
    </div>
  );
}
