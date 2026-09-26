import { describe, expect, it } from 'vitest';
import { avatarSrc } from './avatar-url';

const PROJECT = 'https://proj.supabase.co';
const OWN = `${PROJECT}/storage/v1/object/public/avatars/1111/avatar.webp?t=1`;

describe('avatarSrc', () => {
  it('draws a picture from this project’s avatars bucket', () => {
    expect(avatarSrc(OWN, PROJECT)).toBe(OWN);
  });

  // `avatar_url` is a column its owner writes with any string. Rendered as-is,
  // every contact's app fetches the owner's chosen URL on every screen that
  // shows them — an IP and online-time log for whoever runs that server.
  it('refuses any other host, including another Supabase project', () => {
    expect(avatarSrc('https://tracker.example/p.gif', PROJECT)).toBeNull();
    expect(avatarSrc('https://evil.supabase.co/storage/v1/object/public/avatars/x', PROJECT)).toBeNull();
    expect(avatarSrc(`${PROJECT}.evil.example/storage/v1/object/public/avatars/x`, PROJECT)).toBeNull();
  });

  it('refuses a same-host path outside the avatars bucket', () => {
    expect(avatarSrc(`${PROJECT}/storage/v1/object/public/other/x`, PROJECT)).toBeNull();
  });

  it('has nothing to draw for nothing', () => {
    expect(avatarSrc(null, PROJECT)).toBeNull();
    expect(avatarSrc('', PROJECT)).toBeNull();
  });
});
