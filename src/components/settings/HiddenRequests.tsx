import { useCallback, useEffect, useState } from 'react';
import { EyeOff } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { loadChatFlags, setDismissed } from '../../lib/chat-flags';
import type { Profile } from '../../lib/types';
import { Card, Note, SettingsPage } from './SettingsUi';
import { Avatar } from '../Avatar';

interface HiddenRequestsProps {
  onBack: () => void;
}

/**
 * The people this device is not showing requests from, and the way back.
 *
 * Dismissal happens in two places that are easy to forget — declining a request
 * and deleting a chat — and both are silent by design. A hidden list with no
 * screen would be a block list the user cannot inspect, undo, or remember
 * making, which is the kind of state this app does not keep about people.
 */
export function HiddenRequests({ onBack }: HiddenRequestsProps) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const flags = await loadChatFlags();
    const ids = [...flags.values()].filter((f) => f.dismissedAt).map((f) => f.id);
    if (ids.length === 0) {
      setProfiles([]);
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from('profiles')
      .select('id, display_name, avatar_url')
      .in('id', ids);
    // A profile that no longer resolves — a deleted account — still had a
    // dismissal, and dropping the row silently would leave a flag nobody can
    // see. It is listed by id rather than hidden.
    const found = (data as Profile[] | null) ?? [];
    setProfiles(
      ids.map(
        (id) =>
          found.find((p) => p.id === id) ?? { id, display_name: '', avatar_url: null }
      )
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SettingsPage title="Hidden requests" onBack={onBack}>
      <Card>
        {loading ? (
          <p className="px-3 py-3 text-sm text-base-content/60">Loading…</p>
        ) : profiles.length === 0 ? (
          <p className="px-3 py-3 text-sm text-base-content/60">
            Nobody is hidden on this device.
          </p>
        ) : (
          profiles.map((profile) => (
            <div key={profile.id} className="flex items-center gap-3 px-3 py-2.5">
              <Avatar display_name={profile.display_name} url={profile.avatar_url} size={32} />
              <span className="flex-1 min-w-0 truncate text-sm">
                {profile.display_name ? `@${profile.display_name}` : 'Account no longer exists'}
              </span>
              <button
                className="btn btn-ghost btn-xs"
                onClick={async () => {
                  await setDismissed(profile.id, false);
                  await load();
                }}
              >
                Unhide
              </button>
            </div>
          ))
        )}
      </Card>

      {/* Says exactly what this is and is not. A page that let "hidden" read as
          "blocked" would be claiming a protection the server does not enforce. */}
      <Note>
        Hidden on this device. They cannot message or call you: that needs a contact you
        accepted. They can still send a request; you just will not see it. There is no block
        list on the server, so nothing here tells us who you are avoiding.
      </Note>

      <div className="flex items-center gap-2 px-1 pt-1 text-xs text-base-content/50">
        <EyeOff className="w-3.5 h-3.5 shrink-0" />
        <span>Declining a request or deleting a chat hides that person here.</span>
      </div>
    </SettingsPage>
  );
}
