// Shared date/time formatting. Lifted out of ChatRoom so the conversation list
// and the message thread agree on what "Yesterday" means.

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Whole days between two instants, counted by calendar day, not by hours. */
function daysAgo(iso: string): number {
  const then = startOfDay(new Date(iso)).getTime();
  const today = startOfDay(new Date()).getTime();
  return Math.round((today - then) / 86_400_000);
}

/** Clock time only: "14:32". */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Date divider label for the message thread. */
export function formatDate(iso: string): string {
  const days = daysAgo(iso);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/**
 * Timestamp for a conversation row: precise for today, coarse beyond it —
 * the list wants recency at a glance, not a full date on every line.
 */
export function formatListTime(iso: string): string {
  const days = daysAgo(iso);
  if (days === 0) return formatTime(iso);
  if (days === 1) return 'Yesterday';
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/**
 * "Last seen …" label for a friend's header when they're offline. `null`
 * (never persisted, e.g. an account that predates this column) renders as
 * `''` so the caller shows nothing rather than a bogus "Last seen".
 */
export function formatLastSeen(iso: string | null): string {
  if (!iso) return '';
  const days = daysAgo(iso);
  if (days === 0) return `Last seen ${formatTime(iso)}`;
  if (days === 1) return `Last seen yesterday at ${formatTime(iso)}`;
  return `Last seen ${new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}
