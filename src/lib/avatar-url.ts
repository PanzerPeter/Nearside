// Whether a profile picture URL may be drawn.
//
// `profiles.avatar_url` is written by the profile's owner, and nothing on the
// server says what it holds: the app writes a public URL out of the `avatars`
// bucket, but a direct PostgREST update can write any string. Drawn as-is, a
// contact's avatar pointing at their own server is a tracking pixel — every
// screen that shows them sends that server this device's IP address, and
// when, which is more than a message reveals. So a picture is drawn only from
// this project's own avatars bucket, and anything else falls back to initials.

/**
 * `url` when it is a picture out of this project's `avatars` bucket, else null.
 *
 * A prefix match on the whole origin plus bucket path, not a hostname check:
 * `*.supabase.co` would still admit a bucket on a project the contact owns,
 * whose access log is theirs to read.
 */
export function avatarSrc(
  url: string | null | undefined,
  projectUrl: string = import.meta.env.VITE_SUPABASE_URL
): string | null {
  if (!url || !projectUrl) return null;
  const prefix = `${projectUrl.replace(/\/+$/, '')}/storage/v1/object/public/avatars/`;
  return url.startsWith(prefix) ? url : null;
}
