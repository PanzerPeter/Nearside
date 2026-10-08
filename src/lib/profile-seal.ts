// Sealed profiles (0061): the name, bio and picture behind a key only the
// people you are connected to hold.
//
// Module-level, like `peer-keys.ts` and the room key cache, for the same
// reason: profiles are read in a dozen places — the list, the header, the
// profile card, the call screen, notifications — and most of them have a
// session but no identity. `setProfileSession` is called once by App when the
// identity is ready, `releaseProfiles` by the account teardown, and every read
// in between goes through `revealProfiles`.
//
// What the server holds per person: the profile key sealed under their own
// vault key, the profile sealed under the profile key, and one grant per
// reader — the profile key boxed from owner to reader. See 0061's header.

import sodium from 'libsodium-wrappers';
import { supabase } from './supabase';
import { fromBase64, toBase64, type Identity } from './crypto/keys';
import { openBytesFrom, openForSelf, sealBytesFor, sealForSelf } from './crypto/seal';
import { openFile, sealFile } from './media-crypto';
import { peerPublicKey } from './peer-keys';
import { keyChanged } from './verification';
import {
  decodeProfile,
  encodeProfile,
  grantPlan,
  normalizeDisplayName,
  type ProfilePlain,
} from './profile-shape';
import { normalizeBio } from './bio';
import { t } from './i18n';

let session: { me: string; identity: Identity } | null = null;
let ownKey: Uint8Array | null = null;
/** Opened profiles by owner, keyed to the ciphertext they came from so a
 *  changed profile is opened again and an unchanged one is not. */
const opened = new Map<string, { ciphertext: string; profile: ProfilePlain | null }>();
/** Decrypted pictures by object path. */
const avatarUrls = new Map<string, Promise<string | null>>();
let syncing: Promise<void> | null = null;
let lastSync = 0;

export function setProfileSession(me: string, identity: Identity): void {
  if (session && (session.me !== me || session.identity !== identity)) releaseProfiles();
  session = { me, identity };
}

/** Part of the account teardown: nothing opened under one account may be
 *  readable from the next. */
export function releaseProfiles(): void {
  session = null;
  ownKey = null;
  opened.clear();
  for (const url of avatarUrls.values()) {
    void url.then((u) => u && URL.revokeObjectURL(u));
  }
  avatarUrls.clear();
  lastSync = 0;
}

function need() {
  if (!session) throw new Error('profile session not set');
  return session;
}

// ---------------------------------------------------------------------------
// Your own profile
// ---------------------------------------------------------------------------

async function writeNewKey(): Promise<Uint8Array> {
  const { me, identity } = need();
  await sodium.ready;
  const key = sodium.crypto_secretbox_keygen();
  const sealed = await sealForSelf(identity.vaultKey, await toBase64(key));
  const { error } = await supabase
    .from('profiles')
    .update({ profile_key_ciphertext: sealed.ciphertext, profile_key_nonce: sealed.nonce })
    .eq('id', me);
  if (error) throw error;
  ownKey = key;
  return key;
}

async function ownProfileKey(): Promise<Uint8Array> {
  if (ownKey) return ownKey;
  const { me, identity } = need();
  const { data, error } = await supabase
    .from('profiles')
    .select('profile_key_ciphertext, profile_key_nonce')
    .eq('id', me)
    .maybeSingle();
  if (error) throw error;
  if (data?.profile_key_ciphertext && data.profile_key_nonce) {
    const text = await openForSelf(identity.vaultKey, {
      ciphertext: data.profile_key_ciphertext,
      nonce: data.profile_key_nonce,
    });
    ownKey = await fromBase64(text);
    return ownKey;
  }
  return writeNewKey();
}

/** Seal and store your profile, and clear every plaintext column it replaces. */
export async function publishProfile(profile: ProfilePlain): Promise<void> {
  const { me } = need();
  const key = await ownProfileKey();
  const sealed = await sealForSelf(key, encodeProfile(profile));
  const { error } = await supabase
    .from('profiles')
    .update({
      profile_ciphertext: sealed.ciphertext,
      profile_nonce: sealed.nonce,
      display_name: null,
      bio: null,
      avatar_url: null,
    })
    .eq('id', me);
  if (error) throw error;
  opened.set(me, { ciphertext: sealed.ciphertext, profile });
}

/** Your profile as it stands, opened — or null before you have one. */
export async function ownProfile(): Promise<ProfilePlain | null> {
  const { me } = need();
  const { data } = await supabase
    .from('profiles')
    .select('profile_ciphertext, profile_nonce')
    .eq('id', me)
    .maybeSingle();
  if (!data?.profile_ciphertext || !data.profile_nonce) return null;
  const hit = opened.get(me);
  if (hit && hit.ciphertext === data.profile_ciphertext) return hit.profile;
  const text = await openForSelf(await ownProfileKey(), {
    ciphertext: data.profile_ciphertext,
    nonce: data.profile_nonce,
  });
  const profile = decodeProfile(text, me);
  opened.set(me, { ciphertext: data.profile_ciphertext, profile });
  return profile;
}

/** Seal a picture for your profile and upload it as opaque bytes. The file key
 *  goes into the profile, which is what makes the object openable at all. */
export async function uploadSealedAvatar(file: Blob): Promise<{ path: string; key: string }> {
  const { me } = need();
  const { blob, key } = await sealFile(new Uint8Array(await file.arrayBuffer()));
  const path = `${me}/${crypto.randomUUID()}.bin`;
  const { error } = await supabase.storage.from('avatars').upload(path, blob, {
    // A new name every time, so a year is safe: a changed picture is a
    // different object and can never be served from a cache holding the old.
    cacheControl: '31536000',
    contentType: 'application/octet-stream',
  });
  if (error) throw error;
  return { path, key: await toBase64(key) };
}

/** Best effort: an object nothing points at any more. */
export async function removeAvatarObject(path: string | null | undefined): Promise<void> {
  if (!path) return;
  await supabase.storage.from('avatars').remove([path]).catch(() => {});
}

/**
 * Change your own profile: any of the name, the bio and the picture.
 *
 * Read-modify-write on the sealed blob, so changing one field never drops the
 * others. `base` is what the screen was showing, used only when there is no
 * sealed profile yet to start from. A replaced picture's object is deleted
 * once the profile no longer names it.
 */
export async function updateOwnProfile(
  base: { display_name: string; bio?: string | null },
  patch: { display_name?: string; bio?: string | null; avatar?: Blob }
): Promise<{ display_name: string; bio: string | null; avatar_url: string | null }> {
  const current: ProfilePlain = (await ownProfile()) ?? {
    display_name: normalizeDisplayName(base.display_name) ?? '',
    bio: normalizeBio(base.bio ?? ''),
    avatar: null,
  };
  const display_name =
    patch.display_name !== undefined ? normalizeDisplayName(patch.display_name) : current.display_name;
  if (!display_name) throw new Error('a profile needs a name');
  const avatar = patch.avatar ? await uploadSealedAvatar(patch.avatar) : current.avatar;
  const next: ProfilePlain = {
    display_name,
    bio: patch.bio !== undefined ? normalizeBio(patch.bio ?? '') : current.bio,
    avatar,
  };
  await publishProfile(next);
  if (patch.avatar && current.avatar) await removeAvatarObject(current.avatar.path);
  return {
    display_name: next.display_name,
    bio: next.bio,
    avatar_url: next.avatar ? await avatarUrl(next.avatar.path, next.avatar.key) : null,
  };
}

const PENDING_NAME = 'nearside.pendingName';

/** The name typed at signup, held on this device until there is an identity to
 *  seal it with. Signup no longer sends it to the auth service. */
export function rememberPendingName(name: string): void {
  try {
    localStorage.setItem(PENDING_NAME, name);
  } catch {
    // Settings asks for a name if this is lost.
  }
}

function takePendingName(): string | null {
  try {
    const name = localStorage.getItem(PENDING_NAME);
    localStorage.removeItem(PENDING_NAME);
    return name;
  } catch {
    return null;
  }
}

/** The object path of a pre-0061 public avatar URL, or null. */
export function legacyAvatarPath(url: string | null | undefined): string | null {
  if (!url) return null;
  const marker = '/storage/v1/object/public/avatars/';
  const at = url.indexOf(marker);
  if (at < 0) return null;
  return decodeURIComponent(url.slice(at + marker.length).split('?')[0]) || null;
}

/**
 * Move a plaintext profile into a sealed one, once.
 *
 * Runs on every start and returns at once when there is nothing to do. The
 * picture is fetched from its public URL, sealed, uploaded as a new object,
 * and the old one deleted; the name the auth service was handed at signup is
 * cleared from it too, since `raw_user_meta_data` held a copy.
 */
export async function sealOwnProfileIfNeeded(): Promise<void> {
  const { me } = need();
  const { data, error } = await supabase
    .from('profiles')
    .select('display_name, bio, avatar_url, profile_ciphertext')
    .eq('id', me)
    .maybeSingle();
  // A database without 0061 answers with an error here; nothing changes.
  if (error || !data || data.profile_ciphertext) return;

  const name = normalizeDisplayName(data.display_name ?? takePendingName() ?? '');
  if (!name) return;

  let avatar: ProfilePlain['avatar'] = null;
  const oldPath = legacyAvatarPath(data.avatar_url);
  if (data.avatar_url && oldPath) {
    try {
      const response = await fetch(data.avatar_url);
      if (response.ok) avatar = await uploadSealedAvatar(await response.blob());
    } catch {
      // Sealed without a picture rather than not at all: the name and bio
      // matter more, and a picture can be set again in a tap.
    }
  }

  await publishProfile({ display_name: name, bio: normalizeBio(data.bio ?? ''), avatar });
  if (oldPath) await removeAvatarObject(oldPath);
  await supabase.auth.updateUser({ data: { display_name: null, username: null } }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Who holds the key
// ---------------------------------------------------------------------------

/** A friend list refresh asks for a sync each time; this is how often one
 *  actually runs unless something changed for certain. */
const SYNC_EVERY_MS = 30_000;

/**
 * Bring the grants into line with the people who can read your profile row:
 * everyone you have a friendship row with, pending included.
 *
 * Called on start and whenever the friend list reloads. `force` skips the
 * throttle, for the moments a change is known — a request sent, accepted or
 * removed.
 */
export function syncProfileGrants(force = false): Promise<void> {
  if (!session) return Promise.resolve();
  if (syncing) return syncing;
  if (!force && Date.now() - lastSync < SYNC_EVERY_MS) return Promise.resolve();
  syncing = doSync()
    .catch((error) => console.error('profile grant sync failed', error))
    .finally(() => {
      syncing = null;
      lastSync = Date.now();
    });
  return syncing;
}

async function doSync(): Promise<void> {
  const { me, identity } = need();
  // Nothing to hand anybody until there is a sealed profile to open.
  if (!(await ownProfile())) return;

  const [{ data: friendships, error: fError }, { data: grants, error: gError }] = await Promise.all([
    supabase
      .from('friendships')
      .select('requester_id, addressee_id')
      .or(`requester_id.eq.${me},addressee_id.eq.${me}`),
    supabase.from('profile_keys').select('reader_id').eq('owner_id', me),
  ]);
  if (fError || gError) return;

  const audience = new Set<string>();
  for (const f of friendships ?? []) {
    const other = f.requester_id === me ? f.addressee_id : f.requester_id;
    if (other !== me) audience.add(other);
  }
  const plan = grantPlan(audience, new Set((grants ?? []).map((g) => g.reader_id as string)));

  let key = await ownProfileKey();
  if (plan.rotate) {
    // Read before the key changes: after it, the stored profile is sealed
    // under a key this device no longer holds.
    const current = await ownProfile();
    key = await writeNewKey();
    if (current) await publishProfile(current);
    await supabase.from('profile_keys').delete().eq('owner_id', me).in('reader_id', plan.remove);
  }
  if (!plan.add.length) return;

  const rows = [];
  for (const reader of plan.add) {
    const theirs = await peerPublicKey(reader);
    // Not to a key the app is already warning about: a profile handed to an
    // interceptor is a profile handed out, whatever the composer then refuses.
    if (!theirs || (await keyChanged(reader, theirs))) continue;
    const sealed = await sealBytesFor(identity.boxPrivate, theirs, key);
    rows.push({ owner_id: me, reader_id: reader, key_ciphertext: sealed.ciphertext, key_nonce: sealed.nonce });
  }
  if (rows.length) {
    await supabase.from('profile_keys').upsert(rows, { onConflict: 'owner_id,reader_id' });
  }
}

// ---------------------------------------------------------------------------
// Reading other people's
// ---------------------------------------------------------------------------

function avatarUrl(path: string, fileKey: string): Promise<string | null> {
  const hit = avatarUrls.get(path);
  if (hit) return hit;
  const pending = (async () => {
    try {
      const { data } = supabase.storage.from('avatars').getPublicUrl(path);
      const response = await fetch(data.publicUrl);
      if (!response.ok) return null;
      const bytes = await openFile(new Uint8Array(await response.arrayBuffer()), await fromBase64(fileKey));
      return URL.createObjectURL(new Blob([bytes as BlobPart]));
    } catch {
      return null;
    }
  })();
  avatarUrls.set(path, pending);
  return pending;
}

interface ProfileRow {
  id: string;
  display_name?: string | null;
  avatar_url?: string | null;
  bio?: string | null;
}

/**
 * Rows with their sealed profiles laid over them.
 *
 * Every place that reads a profile passes its rows through here, which is what
 * let the rest of the app keep reading `display_name` and `avatar_url` off a
 * row as it always did. A row whose owner has not sealed yet keeps its
 * plaintext; one this device holds no key for — a friend whose app has not
 * granted one yet — reads as "Contact" until it does.
 */
export async function revealProfiles<T extends ProfileRow>(
  rows: T[]
): Promise<(T & { display_name: string })[]> {
  const fallback = (row: T) => ({ ...row, display_name: row.display_name || t('profile.unknown') });
  if (!session || rows.length === 0) return rows.map(fallback);
  const { me, identity } = session;
  const ids = [...new Set(rows.map((r) => r.id))];

  const [{ data: sealedRows, error }, { data: grants }] = await Promise.all([
    supabase.from('profiles').select('id, profile_ciphertext, profile_nonce').in('id', ids),
    supabase
      .from('profile_keys')
      .select('owner_id, key_ciphertext, key_nonce')
      .eq('reader_id', me)
      .in('owner_id', ids),
  ]);
  if (error) return rows.map(fallback);

  const grantBy = new Map((grants ?? []).map((g) => [g.owner_id as string, g]));
  const profiles = new Map<string, ProfilePlain | null>();
  await Promise.all(
    (sealedRows ?? []).map(async (row) => {
      if (!row.profile_ciphertext || !row.profile_nonce) return;
      const hit = opened.get(row.id);
      if (hit && hit.ciphertext === row.profile_ciphertext) {
        profiles.set(row.id, hit.profile);
        return;
      }
      let profile: ProfilePlain | null = null;
      try {
        let key: Uint8Array | null = null;
        if (row.id === me) {
          key = await ownProfileKey();
        } else {
          const grant = grantBy.get(row.id);
          const theirs = grant ? await peerPublicKey(row.id) : null;
          if (grant && theirs) {
            key = await openBytesFrom(identity.boxPrivate, theirs, {
              ciphertext: grant.key_ciphertext,
              nonce: grant.key_nonce,
            });
          }
        }
        if (key) {
          const text = await openForSelf(key, {
            ciphertext: row.profile_ciphertext,
            nonce: row.profile_nonce,
          });
          profile = decodeProfile(text, row.id);
          opened.set(row.id, { ciphertext: row.profile_ciphertext, profile });
        }
      } catch {
        profile = null;
      }
      // Sealed, and not openable here: no plaintext to fall back on either.
      profiles.set(row.id, profile);
    })
  );

  return Promise.all(
    rows.map(async (row) => {
      if (!profiles.has(row.id)) return fallback(row);
      const profile = profiles.get(row.id);
      if (!profile) {
        return { ...row, display_name: t('profile.unknown'), avatar_url: null, bio: null };
      }
      return {
        ...row,
        display_name: profile.display_name,
        bio: profile.bio,
        avatar_url: profile.avatar ? await avatarUrl(profile.avatar.path, profile.avatar.key) : null,
      };
    })
  );
}

/** One row. */
export async function revealProfile<T extends ProfileRow>(row: T): Promise<T & { display_name: string }> {
  return (await revealProfiles([row]))[0];
}
