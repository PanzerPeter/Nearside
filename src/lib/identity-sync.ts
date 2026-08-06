import type { Session } from '@supabase/supabase-js';
import { toBase64, type Identity } from './crypto/keys';
import { supabase } from './supabase';

/** Exactly the three columns 0020 added, and nothing else. Extracted from the
 *  writer so a test can assert no private half ever reaches the payload. */
export async function publicKeyPayload(identity: Identity) {
  return {
    public_key: await toBase64(identity.boxPublic),
    signing_key: await toBase64(identity.signPublic),
    key_updated_at: new Date().toISOString(),
  };
}

/** Idempotent: writes only when the stored keys differ from this device's. */
export async function syncPublicKeys(session: Session, identity: Identity): Promise<void> {
  const payload = await publicKeyPayload(identity);
  const { data } = await supabase
    .from('profiles')
    .select('public_key, signing_key')
    .eq('id', session.user.id)
    .maybeSingle();

  if (data?.public_key === payload.public_key && data?.signing_key === payload.signing_key) return;
  await supabase.from('profiles').update(payload).eq('id', session.user.id);
}
