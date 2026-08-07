// Editing and deleting a message that already has a server row.
//
// Neither writes back to `messages`: both land as an UPDATE on the row, and
// the realtime UPDATE handler is what folds the result into the thread — for
// this device exactly as for the other one.

import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Message } from '../lib/types';
import { MAX_MESSAGE_LENGTH, tombstonePatch } from '../lib/conversation';
import { sealBody } from '../lib/sealed-body';
import { peerPublicKey } from '../lib/peer-keys';
import { forgetCachedMessage } from '../lib/localdb';
import type { Identity } from '../lib/crypto/keys';

export interface MessageEditing {
  editingId: string | null;
  editingText: string;
  setEditingText: (v: string) => void;
  startEdit: (msg: Message) => void;
  cancelEdit: () => void;
  saveEdit: (id: string) => Promise<void>;
  deleteMessage: (msg: Message) => Promise<void>;
}

interface MessageEditingOptions {
  me: string;
  peerId: string;
  identity: Identity;
  onError: (message: string) => void;
}

export function useMessageEditing({
  me,
  peerId,
  identity,
  onError,
}: MessageEditingOptions): MessageEditing {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');

  function startEdit(msg: Message) {
    setEditingId(msg.id);
    setEditingText(msg.text ?? '');
  }

  async function saveEdit(id: string) {
    const trimmed = editingText.trim();
    if (!trimmed) return;
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      onError(`Message is too long (${MAX_MESSAGE_LENGTH} characters max).`);
      return;
    }
    setEditingId(null);
    // Re-sealed, not written back as plaintext: an edit in the vault must
    // leave the row exactly as unreadable as the send did.
    const { error: updateError } = await supabase
      .from('messages')
      .update({
        ...(await sealBody(identity, await peerPublicKey(peerId), me, peerId, trimmed)),
        edited_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (updateError) onError('Could not edit message.');
  }

  async function deleteMessage(msg: Message) {
    setEditingId(null);
    if (msg.media_path) {
      await supabase.storage.from('chat-media').remove([msg.media_path]);
    }
    const { error: deleteError } = await supabase
      .from('messages')
      .update(tombstonePatch())
      .eq('id', msg.id);
    if (deleteError) {
      onError('Could not delete message.');
      return;
    }
    // The server's copy is stripped; this device's decrypted copy has to go
    // with it, or the body the user just deleted stays in search results and
    // in the sidebar preview for as long as the mirror lives.
    await forgetCachedMessage(msg.id);
  }

  return {
    editingId,
    editingText,
    setEditingText,
    startEdit,
    cancelEdit: () => setEditingId(null),
    saveEdit,
    deleteMessage,
  };
}
