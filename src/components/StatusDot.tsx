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
  /** Emit a slow halo while the peer is active, under the expressive motion
   *  set. Opt-in, and only one caller takes it: the same halo repeated down a
   *  list of conversations is noise behind the text you are trying to read. */
  pulse?: boolean;
}

/** Small presence indicator: green / amber / grey with a surface-coloured ring. */
export function StatusDot({ status, size = 12, className = '', pulse = false }: StatusDotProps) {
  return (
    <span
      // `relative` only when pulsing: the halo is an absolutely positioned
      // ::after and needs this dot as its containing block.
      className={`inline-block rounded-full ${pulse ? 'motion-presence relative ' : ''}${className}`}
      data-presence={pulse ? status : undefined}
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

// The same three-status vocabulary the dot already renders as its aria-label,
// shared with ChatHeader so the written status and the coloured dot can never
// disagree. react-refresh/only-export-components fires on it; splitting a
// three-entry lookup into a module of its own to satisfy a dev-only HMR rule
// costs more than it buys.
// eslint-disable-next-line react-refresh/only-export-components
export { LABELS as presenceLabels };
