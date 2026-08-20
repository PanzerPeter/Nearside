// Editing and deleting a message that already has a server row.
//
// Neither writes back to `messages`: both land as an UPDATE on the row, and
// the realtime UPDATE handler is what folds the result into the thread — for
// this device exactly as for the other one.

import { useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Message } from '../lib/types';
import { MAX_MESSAGE_LENGTH, isBodyOptional, tombstonePatch } from '../lib/conversation';
import { sealBody } from '../lib/sealed-body';
import { peerPublicKey } from '../lib/peer-keys';
import { forgetCachedMessage } from '../lib/localdb';
import { repinCaption } from '../lib/pins';
import type { Identity } from '../lib/crypto/keys';

export interface MessageEditing {
  editingId: string | null;
  editingText: string;
  /** True while an edit is on its way to the server. The editor stays open and
   *  the save control spins, because the text only exists here until the row
   *  comes back changed. */
  savingEdit: boolean;
  /** Whether the edit in progress is worth committing. Empty is a legitimate
   *  edit for an attachment — it takes the caption back — and nothing at all
   *  for a text message, which is what deleting is for. */
  canSave: boolean;
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
  // Whether the row being edited carries an attachment: it decides both what an
  // empty body means and whether a pinned copy has to be told about the change.
  // State rather than a ref, because the save control reads it on every render.
  const [mediaBacked, setMediaBacked] = useState(false);
  // What the message said when the editor opened, so an unchanged body can be
  // recognised as the no-op it is.
  const originalText = useRef('');

  function startEdit(msg: Message) {
    setEditingId(msg.id);
    setEditingText(msg.text ?? '');
    originalText.current = msg.text ?? '';
    setMediaBacked(isBodyOptional(msg));
  }

  async function saveEdit(id: string) {
    if (savingEdit) return;
    const trimmed = editingText.trim();
    if (!trimmed && !mediaBacked) return;
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
    //
    // A caption cleared to nothing goes back to null columns — the same shape
    // an attachment sent without a caption has, which `has_body` allows because
    // the media path is still a body. Sealing an empty string instead would
    // leave the row carrying a body that opens to nothing, and every reader
    // treats that as a message somebody sent empty.
    const body = trimmed
      ? await sealBody(identity, await peerPublicKey(peerId), me, peerId, trimmed)
      : { ciphertext: null, nonce: null };
    const { error: updateError } = await supabase
      .from('messages')
      .update({
        ...body,
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
    // The two local copies of the plaintext, which no realtime UPDATE reaches.
    // A rewritten body arrives back through `openRows` and re-caches itself; a
    // cleared one never arrives at all, so the old caption would sit in search
    // and in the sidebar preview for as long as the mirror lives.
    if (!trimmed) await forgetCachedMessage(id);
    if (mediaBacked) await repinCaption(id, trimmed);
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
    canSave: editingText.trim().length > 0 || mediaBacked,
    setEditingText,
    startEdit,
    cancelEdit: () => setEditingId(null),
    saveEdit,
    deleteMessage,
  };
}
