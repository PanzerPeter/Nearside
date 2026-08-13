// Editing and deleting a message that already has a server row.
//
// Neither writes back to `messages`: both land as an UPDATE on the row, and
// the realtime UPDATE handler is what folds the result into the thread — for
// this device exactly as for the other one.

import { useRef, useState } from 'react';
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
  /** True while an edit is on its way to the server. The editor stays open and
   *  the save control spins, because the text only exists here until the row
   *  comes back changed. */
  savingEdit: boolean;
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
  const [savingEdit, setSavingEdit] = useState(false);
  // What the message said when the editor opened, so an unchanged body can be
  // recognised as the no-op it is.
  const originalText = useRef('');

  function startEdit(msg: Message) {
    setEditingId(msg.id);
    setEditingText(msg.text ?? '');
    originalText.current = msg.text ?? '';
  }

  async function saveEdit(id: string) {
    if (savingEdit) return;
    const trimmed = editingText.trim();
    if (!trimmed) return;
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      onError(`Message is too long (${MAX_MESSAGE_LENGTH} characters max).`);
      return;
    }
    // The same text back is not an edit. Writing it anyway would re-seal the
    // row and stamp `edited_at`, hanging "(edited)" on a message nobody changed.
    if (trimmed === originalText.current.trim()) {
      setEditingId(null);
      return;
    }
    setSavingEdit(true);
    // Re-sealed, not written back as plaintext: an edit in the vault must
    // leave the row exactly as unreadable as the send did.
    const { error: updateError } = await supabase
      .from('messages')
      .update({
        ...(await sealBody(identity, await peerPublicKey(peerId), me, peerId, trimmed)),
        edited_at: new Date().toISOString(),
      })
      .eq('id', id);
    setSavingEdit(false);
    // Closed only once the row is actually changed. Closing first and failing
    // afterwards threw away the text the user had just typed, leaving a toast
    // and the old message as the only trace of it.
    if (updateError) {
      onError('Could not edit message.');
      return;
    }
    setEditingId(null);
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
    savingEdit,
    setEditingText,
    startEdit,
    cancelEdit: () => setEditingId(null),
    saveEdit,
    deleteMessage,
  };
}
