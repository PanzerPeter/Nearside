import { Avatar } from './Avatar';
import { StatusDot } from './StatusDot';
import { usePresenceStatus } from '../hooks/usePresence';

interface AvatarWithStatusProps {
  userId: string;
  username?: string | null;
  url?: string | null;
  size?: number;
}

/** Avatar with a live presence dot in the bottom-right corner. */
export function AvatarWithStatus({ userId, username, url, size = 40 }: AvatarWithStatusProps) {
  const status = usePresenceStatus(userId);
  // Scale the dot with the avatar, clamped to a legible range.
  const dot = Math.max(9, Math.min(14, Math.round(size * 0.3)));

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <Avatar username={username} url={url} size={size} />
      <span className="absolute -bottom-0.5 -right-0.5">
        <StatusDot status={status} size={dot} />
      </span>
    </div>
  );
}
