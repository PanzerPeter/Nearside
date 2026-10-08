// The sealed profile's plaintext, and the bookkeeping for who holds its key.
//
// Pure, so the two decisions that are easy to get wrong without noticing —
// what a profile blob may contain, and when a key has to be rotated — are
// tested in node. The crypto and the network live in `profile-seal.ts`.

import { normalizeBio } from './bio';

/** What the profile key seals. The picture is referenced, not embedded: its
 *  bytes are their own sealed object in the avatars bucket. */
export interface ProfilePlain {
  display_name: string;
  bio: string | null;
  avatar: { path: string; key: string } | null;
}

/** The `display_name_length` CHECK's limit, which the server can no longer
 *  apply once the name is ciphertext. The bio's is `bio.ts`'s, reused. */
export const DISPLAY_NAME_MAX = 32;

const clip = (text: string, max: number) =>
  Array.from(text.replace(/\p{Cc}/gu, ' ').trim()).slice(0, max).join('').trim();

/** A name as it will be sealed, or null when nothing is left of it. */
export function normalizeDisplayName(name: string): string | null {
  return clip(name, DISPLAY_NAME_MAX) || null;
}

export function encodeProfile(profile: ProfilePlain): string {
  return JSON.stringify({
    v: 1,
    n: profile.display_name,
    b: profile.bio,
    a: profile.avatar ? { p: profile.avatar.path, k: profile.avatar.key } : null,
  });
}

/**
 * A blob back into a profile, or null when it is not one.
 *
 * Everything is checked rather than trusted. The blob opened under a key its
 * owner chose, so it is theirs to put anything in — a name of ten thousand
 * characters, an avatar path in somebody else's folder. The limits are applied
 * again here, and a picture outside the owner's own folder is dropped: the
 * folder is the one thing the bucket's policy proves about who uploaded it.
 */
export function decodeProfile(text: string, ownerId: string): ProfilePlain | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || typeof r.n !== 'string') return null;
  const display_name = normalizeDisplayName(r.n);
  if (!display_name) return null;
  const bio = typeof r.b === 'string' ? normalizeBio(r.b) : null;
  let avatar: ProfilePlain['avatar'] = null;
  const a = r.a as Record<string, unknown> | null | undefined;
  if (a && typeof a.p === 'string' && typeof a.k === 'string' && a.p.startsWith(`${ownerId}/`)) {
    avatar = { path: a.p, key: a.k };
  }
  return { display_name, bio, avatar };
}

/**
 * What a sync has to do to make the grants match the people who should hold
 * them.
 *
 * `rotate` is the part that matters. Deleting a grant takes the row away, not
 * the key: whoever held it can still open the profile as it stands, and every
 * later version sealed under the same key. So losing a reader means a new key,
 * the profile resealed under it, and a fresh grant to everyone who is left —
 * which is why `add` is then everybody rather than only the newcomers.
 */
export function grantPlan(
  audience: ReadonlySet<string>,
  granted: ReadonlySet<string>
): { add: string[]; remove: string[]; rotate: boolean } {
  const remove = [...granted].filter((id) => !audience.has(id));
  const rotate = remove.length > 0;
  const add = rotate ? [...audience] : [...audience].filter((id) => !granted.has(id));
  return { add, remove, rotate };
}
