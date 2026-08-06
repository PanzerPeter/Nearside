import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../lib/types';
import { Avatar } from './Avatar';
import { useToast } from '../hooks/useToast';
import { Modal } from './Modal';
import { UserPlus, Search } from 'lucide-react';

interface AddFriendModalProps {
  me: string;
  onClose: () => void;
}

/** Search-by-display_name dialog for sending a friend request. */
export function AddFriendModal({ me, onClose }: AddFriendModalProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Profile[]>([]);
  const [searching, setSearching] = useState(false);
  const toast = useToast();

  async function searchUsers() {
    const needle = searchQuery.trim().toLowerCase();
    if (needle.length < 3) {
      setSearchResults([]);
      toast.error('Type at least 3 characters of their display name.');
      return;
    }
    setSearching(true);
    const { data } = await supabase.rpc('search_profiles', { prefix: needle });
    setSearchResults((data ?? []) as Profile[]);
    setSearching(false);
  }

  async function sendFriendRequest(friendId: string) {
    const { data: existing } = await supabase
      .from('friendships')
      .select('id, requester_id, status')
      .or(
        `and(requester_id.eq.${me},addressee_id.eq.${friendId}),and(requester_id.eq.${friendId},addressee_id.eq.${me})`
      );

    const prior = existing?.[0];
    if (prior) {
      // Distinguish the three states — "a request already exists" left the user
      // guessing, especially when the actionable answer is sitting in their own
      // pending list.
      toast.error(
        prior.status === 'accepted'
          ? 'You are already friends.'
          : prior.requester_id === me
            ? 'You already sent them a request — waiting on their reply.'
            : 'They already sent you a request — accept it from your pending list.'
      );
      return;
    }

    const { error } = await supabase.from('friendships').insert({
      requester_id: me,
      addressee_id: friendId,
    });

    if (error) {
      toast.error(
        /rate_limited_requests/.test(error.message)
          ? 'Too many friend requests in the last hour.'
          : error.message
      );
    } else {
      onClose();
      setSearchQuery('');
      setSearchResults([]);
    }
  }

  return (
    <Modal
      title="Add Friend"
      onClose={onClose}
      actions={
        <button
          className="btn btn-ghost"
          onClick={() => {
            onClose();
            setSearchQuery('');
            setSearchResults([]);
          }}
        >
          Close
        </button>
      }
    >
      <p className="text-sm text-base-content/60 mb-4">Search by the start of their display name</p>
      <div className="join w-full">
        <input
          type="text"
          placeholder="Search display name..."
          className="input join-item flex-1 bg-base-200/50 border border-base-content/10 focus:border-primary"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && searchUsers()}
          autoFocus
        />
        <button className="btn btn-primary join-item" onClick={searchUsers} disabled={searching}>
          {searching ? (
            <span className="loading loading-spinner loading-xs" />
          ) : (
            <Search className="w-4 h-4" />
          )}
        </button>
      </div>

      <div className="mt-4 space-y-2 max-h-52 overflow-y-auto">
        {searchResults.map((user) => (
          <div
            key={user.id}
            className="flex items-center justify-between p-3 rounded-xl bg-base-200/50 border border-base-content/5"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <Avatar display_name={user.display_name} url={user.avatar_url} size={32} />
              <span className="text-sm font-medium truncate">@{user.display_name}</span>
            </div>
            <button
              className="btn btn-primary btn-sm gap-1 shrink-0"
              onClick={() => sendFriendRequest(user.id)}
            >
              <UserPlus className="w-3.5 h-3.5" />
              Add
            </button>
          </div>
        ))}
        {searchResults.length === 0 && searchQuery && !searching && (
          <p className="text-sm text-base-content/60 text-center py-4">
            No users found matching "{searchQuery}"
          </p>
        )}
      </div>
    </Modal>
  );
}
