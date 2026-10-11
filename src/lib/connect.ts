// Connecting two accounts without a directory to look each other up in.
//
// A connect code is minted by one side, carried across the gap by a QR the
// other side scans or by eight characters read aloud, and redeemed once. The
// server never learns who was looking for whom, because nobody was looking.
import type { Session } from '@supabase/supabase-js';
import { toBase64, type Identity } from './crypto/keys';
import { SAFETY_VERSION } from './crypto/safety';
import { supabase } from './supabase';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConnectPayload {
  userId: string;
  publicKey: string;
  /** Null from a version-1 code, which predates carrying it. */
  signingKey: string | null;
  token: string;
}

/** The QR carries both public keys as well as the token, so verification can
 *  happen at the moment of connection rather than as a later chore nobody
 *  does. Version 2 added the signing key: a code held up in person verifies
 *  the key group messages are checked against, not only the one sealed to. */
export async function connectPayload(
  session: Session,
  identity: Identity,
  token: string
): Promise<string> {
  const box = await toBase64(identity.boxPublic);
  const sign = await toBase64(identity.signPublic);
  return `nearside:v2:${session.user.id}:${box}:${sign}:${token}`;
}

/** Version 1 is still read: a friend on an older build holds one up. Base64
 *  (ORIGINAL) has no colon in its alphabet, so splitting on one is safe. */
export function parseConnectPayload(text: string): ConnectPayload | null {
  const parts = text.split(':');
  if (parts[0] !== 'nearside') return null;
  const v1 = parts.length === 5 && parts[1] === 'v1';
  const v2 = parts.length === 6 && parts[1] === 'v2';
  if (!v1 && !v2) return null;
  const [userId, publicKey] = [parts[2], parts[3]];
  const signingKey = v2 ? parts[4] : null;
  const token = parts[parts.length - 1];
  if (!UUID.test(userId) || !publicKey || !token || signingKey === '') return null;
  return { userId, publicKey, signingKey, token };
}

export async function mintConnectCode(): Promise<string> {
  const { data, error } = await supabase.rpc('mint_connect_code');
  if (error) throw error;
  return data as string;
}

/** Returns the minting user's id. Throws `code_invalid` for a spent, expired,
 *  unknown or self-issued code — all four are the same thing to the person
 *  typing it, and distinguishing them would confirm which codes exist. */
export async function redeemConnectCode(code: string): Promise<string> {
  const { data, error } = await supabase.rpc('redeem_connect_code', {
    code: code.trim().toUpperCase(),
  });
  if (error) throw error;
  return data as string;
}

/** The safety number as a QR, so two people can compare sixty digits by
 *  holding up a phone instead of reading them out. Spaces are stripped: the
 *  grouping is for the eye, and a scanner should not have to agree with it. */
export function safetyPayload(number: string): string {
  return `nearside-safety:v${SAFETY_VERSION}:${number.replace(/\s+/g, '')}`;
}

/** The digits from a scanned safety QR and the version that made them, or
 *  null if it was some other code. Deliberately not a boolean "matches": the
 *  caller compares against its own number, so this cannot be tricked into
 *  answering yes. The version is returned so a code from a build that hashes
 *  differently reads as "update", not as somebody sitting between you. */
export function parseSafetyPayload(text: string): { version: number; digits: string } | null {
  const m = /^nearside-safety:v(\d+):(\d+)$/.exec(text);
  return m ? { version: Number(m[1]), digits: m[2] } : null;
}

/** How long a minted code lives, mirroring the interval in
 *  `mint_connect_code`. Only the countdown reads it; expiry itself is decided
 *  server-side, so a device with a wrong clock cannot extend a token. */
export const CONNECT_CODE_TTL_MS = 10 * 60 * 1000;

/** The friendship row a redeem found for this pair, if there was one. */
export interface PriorFriendship {
  id: string;
  requester_id: string;
  status: string;
}

/**
 * What redeeming somebody's code should do about the friendship that already
 * exists between the two of you.
 *
 * `accept` is the case this exists for. Declining a request deletes the row and
 * *hides* the person (`setDismissed`), so if they ask again the request never
 * reaches the list — and telling somebody to "accept it from your pending list"
 * when the list is empty by design is a dead end with no way out of it. Holding
 * their code is the same consent accepting would have been, so it accepts.
 *
 * Everything else is a message, not an action: a code cannot un-send a request
 * you made yourself, and it cannot make you more friends than friends.
 */
export type ConnectOutcome = 'accept' | 'already-friends' | 'already-sent' | 'send';

export function connectOutcome(
  prior: PriorFriendship | undefined,
  me: string
): ConnectOutcome {
  if (!prior) return 'send';
  if (prior.status === 'accepted') return 'already-friends';
  return prior.requester_id === me ? 'already-sent' : 'accept';
}
