import { useEffect, useState } from 'react';
import { initial } from '../lib/types';
import { avatarSrc } from '../lib/avatar-url';

interface AvatarProps {
  display_name?: string | null;
  url?: string | null;
  size?: number;
  className?: string;
}

/** Circular avatar: image when available, first-letter fallback otherwise. */
export function Avatar({ display_name, url, size = 40, className = '' }: AvatarProps) {
  const dimension = `${size}px`;
  // Only this project's avatars bucket; anything else is a URL its owner chose
  // for every contact's phone to fetch. See `lib/avatar-url.ts`.
  const src = avatarSrc(url);
  const [broken, setBroken] = useState(false);

  // Reset the error state when the source changes (e.g. avatar re-uploaded).
  useEffect(() => setBroken(false), [url]);

  return (
    <div className="avatar placeholder">
      <div
        className={`rounded-full overflow-hidden bg-base-content/10 text-strong ${className}`}
        style={{ width: dimension, height: dimension }}
      >
        {src && !broken ? (
          <img
            src={src}
            // Empty on purpose. A broken image paints its alt text, and this
            // box is 40px of circle: the name spills out of it as a few
            // clipped letters that read as a rendering fault rather than as a
            // missing picture. The name is already beside every avatar the app
            // draws, so nothing is lost by not repeating it here.
            alt=""
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
