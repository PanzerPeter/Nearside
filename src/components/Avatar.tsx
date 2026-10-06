import { useEffect, useState, type CSSProperties } from 'react';
import { NotebookPen } from 'lucide-react';
import { initial } from '../lib/types';
import { avatarSrc } from '../lib/avatar-url';

interface AvatarProps {
  display_name?: string | null;
  /** What picks the fallback's tint: the person's id where the caller has
   *  it, so the same contact wears the same colour in the list, the header
   *  and every picker. Falls back to the name. */
  seed?: string | null;
  url?: string | null;
  size?: number;
  className?: string;
}

/** Eight hues spaced around the wheel, skipping the band the accent sits in,
 *  so a tinted initial never reads as a control. The tint's lightness and
 *  chroma come from the stylesheet (`.avatar-tint`), per surface and per
 *  theme; only the hue is chosen here. */
const AVATAR_HUES = [28, 62, 105, 150, 190, 290, 320, 350];

/** A stable hue for a seed: FNV-1a over its UTF-16 units. Not a security
 *  property, only a way to make "Mara" the same colour on every render. */
function avatarHue(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return AVATAR_HUES[(hash >>> 0) % AVATAR_HUES.length];
}

/** Circular avatar: image when available, first-letter fallback otherwise. */
export function Avatar({ display_name, seed, url, size = 40, className = '' }: AvatarProps) {
  const dimension = `${size}px`;
  // Only this project's avatars bucket; anything else is a URL its owner chose
  // for every contact's phone to fetch. See `lib/avatar-url.ts`.
  const src = avatarSrc(url);
  const [broken, setBroken] = useState(false);

  // Reset the error state when the source changes (e.g. avatar re-uploaded).
  useEffect(() => setBroken(false), [url]);
  const showImage = !!src && !broken;

  return (
    // Centred by hand rather than through daisyUI's `avatar-placeholder`:
    // this used the v4 name, `placeholder`, which v5 dropped, and the initial
    // has sat in the top-left corner of its circle ever since.
    <div className="inline-flex shrink-0 align-middle">
      <div
        className={`flex items-center justify-center rounded-full overflow-hidden select-none ${
          showImage ? 'bg-base-content/10' : 'avatar-tint'
        } ${className}`}
        style={
          {
            width: dimension,
            height: dimension,
            '--avatar-hue': avatarHue(seed || display_name || '?'),
          } as CSSProperties
        }
      >
        {showImage ? (
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
          <span className="font-semibold leading-none" style={{ fontSize: size * 0.4 }}>
            {initial(display_name)}
          </span>
        )}
      </div>
    </div>
  );
}

/** The self-chat's avatar: a notebook on the brand's own wash, not your
 *  initial, so the vault never looks like one more contact in the list. */
export function VaultAvatar({ size = 40 }: { size?: number }) {
  const glyph = Math.round(size * 0.45);
  return (
    <span
      className="brand-wash flex shrink-0 items-center justify-center rounded-full text-(--brand-lit)"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <NotebookPen style={{ width: glyph, height: glyph }} />
    </span>
  );
}
