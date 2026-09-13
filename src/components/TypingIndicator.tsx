/**
 * Somebody is typing, drawn where what they type will land — a bubble at the
 * tail of the thread rather than a line in the header.
 *
 * The header version replaced the presence line while it showed, so a status
 * that is meant to be steady blinked between "online" and "typing" for as long
 * as somebody was writing. Here the two are separate things in separate
 * places, and the indicator sits directly above the next message.
 *
 * `label` arrives already composed, because who is typing is the caller's
 * question: a 1:1 has one possible answer and a room may have three at once.
 */
export function TypingIndicator({ label, showLabel }: { label: string; showLabel: boolean }) {
  return (
    // Announced once as a sentence, not as three animating dots: the visible
    // part is decoration, and a screen reader has no use for it.
    <div className="flex items-center gap-2 mt-3" aria-live="polite" aria-atomic="true">
      {!showLabel && <span className="sr-only">{label}</span>}
      {/* The incoming bubble's own geometry and fill, minus the padding a line
          of text needs — the dots are the content, and a text-sized box around
          them reads as an empty message. */}
      <div
        className="flex items-center gap-1 px-3.5 py-3 rounded-box rounded-bl-md bg-neutral text-neutral-content shadow-[0_1px_2px_rgba(0,0,0,0.28)] shrink-0"
        aria-hidden="true"
      >
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </div>
      {/* Named only where the name is news. In a 1:1 there is one person it
          could be and the sentence is carried for screen readers alone; in a
          group three dots with no name beside them say nothing at all. */}
      {showLabel && <span className="text-meta text-muted truncate">{label}</span>}
    </div>
  );
}
