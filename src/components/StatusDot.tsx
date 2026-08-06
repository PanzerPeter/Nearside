import { PresenceStatus } from '../hooks/usePresence';

const COLORS: Record<PresenceStatus, string> = {
  active: 'oklch(var(--su))', // success green — open & focused
  background: 'oklch(var(--wa))', // warning amber — open but backgrounded
  offline: 'var(--presence-offline)', // muted grey — not connected
};

const LABELS: Record<PresenceStatus, string> = {
  active: 'Active now',
  background: 'Away',
  offline: 'Offline',
};

interface StatusDotProps {
  status: PresenceStatus;
  size?: number;
  className?: string;
}

/** Small presence indicator: green / amber / grey with a surface-coloured ring. */
export function StatusDot({ status, size = 12, className = '' }: StatusDotProps) {
  return (
    <span
      className={`inline-block rounded-full ${className}`}
      style={{
        width: size,
        height: size,
        backgroundColor: COLORS[status],
        boxShadow: '0 0 0 2px var(--surface-ring)',
      }}
      role="img"
      aria-label={LABELS[status]}
      title={LABELS[status]}
    />
  );
}

export { LABELS as presenceLabels };
