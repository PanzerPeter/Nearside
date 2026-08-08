import { Check, CheckCheck, Clock } from 'lucide-react';
import type { MessageStatusKind } from '../lib/receipts';

const LABELS: Record<MessageStatusKind, string> = {
  pending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
};

/**
 * Lifecycle glyph for one of your own messages, rendered in the bubble's
 * own footer.
 *
 * Three things separate the states, because on a desktop screen any one alone
 * is too subtle: shape (one tick or two), weight (a heavier stroke once read),
 * and colour (the `--receipt-read` mint). Colour alone fails for delivered
 * against read, and shape alone fails for sent against delivered at a 12px
 * hairline, where the second tick reads as anti-aliasing on the first.
 *
 * The glyph sits in a fixed-size box, so none of those changes reflow the
 * footer row as a message walks through its lifecycle.
 */
export function MessageStatus({ status }: { status: MessageStatusKind }) {
  const label = LABELS[status];
  // Pending/sent/delivered inherit the bubble's own text colour
  // (text-primary-content on an own message) and stay dimmed, so they read as
  // part of the footer row alongside the timestamp. `read` breaks out of both:
  // full opacity plus the mint. It can't just be a semantic token — `info` is
  // the same hex as `primary`, and `success` is dark enough against the blue
  // bubble (~1.5:1, and ~1.2:1 once dimmed) that the tick all but vanishes. The
  // dim lives here rather than on the footer container because a parent opacity
  // would clamp this one too.
  const isRead = status === 'read';

  return (
    <span
      className={`inline-flex items-center justify-center w-4 h-3.5 shrink-0 ${
        isRead ? '' : 'opacity-70'
      }`}
      style={isRead ? { color: 'var(--receipt-read)' } : undefined}
      title={label}
      aria-label={label}
    >
      {status === 'pending' && <Clock className="w-3.5 h-3.5" strokeWidth={2.5} aria-hidden />}
      {status === 'sent' && <Check className="w-3.5 h-3.5" strokeWidth={2.75} aria-hidden />}
      {(status === 'delivered' || status === 'read') && (
        <CheckCheck
          className="w-3.5 h-3.5"
          // Read is the state people actually look for, so it gets the heaviest
          // stroke on the row — legible even in greyscale or to a viewer who
          // can't separate the mint from the white beside it.
          strokeWidth={isRead ? 3.25 : 2.5}
          aria-hidden
        />
      )}
    </span>
  );
}
