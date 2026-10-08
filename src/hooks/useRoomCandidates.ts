import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { revealProfiles } from '../lib/profile-seal';
import { unreachableMembers } from '../lib/rooms';
import { blockedPeers } from '../lib/blocks';
import type { Profile } from '../lib/types';
import { useBlockRows } from './useBlocks';

export interface RoomCandidates {
  people: Profile[];
  /** Contacts whose key has not published yet, so the room key cannot be
   *  sealed to them. Shown with the reason rather than dropped. */
  unreachable: Set<string>;
  loading: boolean;
}

/**
 * Who can be put in a group: your accepted contacts, and only them.
 *
 * Not a policy choice — sealing the room key needs their published public key,
 * and there is no directory to look one up in. `participants_insert_creator`
 * enforces the same thing server-side.
 *
 * Anyone on either side of a block is left out rather than drawn: the server
 * refuses them (0055), and one refused row fails the whole insert, so offering
 * them would turn picking five people into adding nobody.
 */
export function useRoomCandidates(me: string): RoomCandidates {
  const [contacts, setContacts] = useState<Profile[]>([]);
  const [unreachable, setUnreachable] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const blockRows = useBlockRows();

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data } = await supabase
        .from('friendships')
        .select('requester_id, addressee_id')
        .eq('status', 'accepted')
        .or(`requester_id.eq.${me},addressee_id.eq.${me}`);

      const peerIds = [
        ...new Set(
          (data ?? [])
            .map((f) => (f.requester_id === me ? f.addressee_id : f.requester_id))
            .filter((id) => id !== me)
        ),
      ];

      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, display_name, avatar_url')
        .in('id', peerIds.length ? peerIds : ['00000000-0000-0000-0000-000000000000']);

      const noKey = await unreachableMembers(peerIds);
      const revealed = await revealProfiles((profiles as Profile[] | null) ?? []);
      if (!alive) return;
      setContacts(revealed);
      setUnreachable(new Set(noKey));
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [me]);

  const people = useMemo(() => {
    const blocked = blockedPeers(blockRows, me);
    return contacts.filter((p) => !blocked.has(p.id));
  }, [contacts, blockRows, me]);

  return { people, unreachable, loading };
}
