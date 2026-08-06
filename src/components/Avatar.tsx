import { useEffect, useState } from 'react';
import { initial } from '../lib/types';

interface AvatarProps {
  display_name?: string | null;
  url?: string | null;
  size?: number;
  className?: string;
}

/** Circular avatar: image when available, first-letter fallback otherwise. */
export function Avatar({ display_name, url, size = 40, className = '' }: AvatarProps) {
  const dimension = `${size}px`;
  const [broken, setBroken] = useState(false);

  // Reset the error state when the source changes (e.g. avatar re-uploaded).
  useEffect(() => setBroken(false), [url]);

  return (
    <div className="avatar placeholder">
      <div
        className={`rounded-full overflow-hidden bg-base-content/10 text-base-content/70 ${className}`}
        style={{ width: dimension, height: dimension }}
      >
        {url && !broken ? (
          <img
            src={url}
            alt={display_name ?? 'avatar'}
            className="w-full h-full object-cover"
            onError={() => setBroken(true)}
          />
        ) : (
          <span className="font-semibold" style={{ fontSize: size * 0.4 }}>
            {initial(display_name)}
          </span>
        )}
      </div>
    </div>
  );
}
