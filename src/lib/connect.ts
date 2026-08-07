// Connecting two accounts without a directory to look each other up in.
//
// A connect code is minted by one side, carried across the gap by a QR the
// other side scans or by eight characters read aloud, and redeemed once. The
// server never learns who was looking for whom, because nobody was looking.
import type { Session } from '@supabase/supabase-js';
import { toBase64, type Identity } from './crypto/keys';
import { supabase } from './supabase';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConnectPayload {
  userId: string;
  publicKey: string;
  token: string;
}

/** The QR carries the public key as well as the token, so verification can
 *  happen at the moment of connection rather than as a later chore nobody
 *  does. */
export async function connectPayload(
  session: Session,
  identity: Identity,
  token: string
): Promise<string> {
  return `nearside:v1:${session.user.id}:${await toBase64(identity.boxPublic)}:${token}`;
}

export function parseConnectPayload(text: string): ConnectPayload | null {
  const parts = text.split(':');
  if (parts.length !== 5) return null;
  const [scheme, version, userId, publicKey, token] = parts;
  if (scheme !== 'nearside' || version !== 'v1') return null;
  if (!UUID.test(userId) || !publicKey || !token) return null;
  return { userId, publicKey, token };
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

/** How long a minted code lives, mirroring the interval in
 *  `mint_connect_code`. Only the countdown reads it; expiry itself is decided
 *  server-side, so a device with a wrong clock cannot extend a token. */
export const CONNECT_CODE_TTL_MS = 10 * 60 * 1000;
