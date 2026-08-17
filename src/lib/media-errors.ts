// Why an attachment did not go, in words the sender can act on.
//
// Sending a photo is six steps in three systems — read the file off the device,
// re-encode it, seal it, put the bytes in Storage, seal the key, write the row
// — and every one of them can fail for its own reason. They all used to arrive
// as the same sentence: "Could not send media." A peer who has never published
// a key, a gallery that will not hand over a cloud-only photo, a migration that
// has not been applied and a dropped connection are four different problems
// with four different remedies, and that string is not enough to tell them
// apart, on a device or in a bug report.
//
// This is `describeWriteError` in lib/background.ts, one layer up: known causes
// get a sentence naming the cause, and anything unrecognised falls through to
// the underlying message rather than to a guess. A message the user does not
// understand still beats one that says nothing — it can be read out, searched
// for, and pasted into an issue.

import { NO_PEER_KEY } from './sealed-body';

/** The union of what actually reaches a catch here: PostgREST returns a plain
 *  object with `code`, Storage and sodium throw `Error`s, the file APIs throw
 *  `DOMException`s whose `name` is the only useful field. */
export interface MediaError {
  code?: string;
  name?: string;
  message?: string;
}

function fields(error: unknown): Required<MediaError> {
  if (typeof error === 'string') return { code: '', name: '', message: error };
  const e = (error ?? {}) as MediaError;
  return {
    code: typeof e.code === 'string' ? e.code : '',
    name: typeof e.name === 'string' ? e.name : '',
    message: typeof e.message === 'string' ? e.message : '',
  };
}

/**
 * A sentence for the toast.
 *
 * `fallback` is what an error carrying no readable text at all comes back as —
 * a rejected fetch with an empty message, or something that is not an error at
 * all. It is the only path that produces the old generic string.
 */
export function describeMediaError(error: unknown, fallback = 'Could not send media.'): string {
  const { code, name, message } = fields(error);

  // Server-side rate limit, raised by the trigger on `messages` and on
  // `room_messages` alike. Named first because it is the one failure that is
  // both expected and entirely temporary.
  if (message.includes('rate_limited_messages')) {
    return "You're sending messages too quickly. Give it a moment.";
  }

  // No key to seal to. The remedy belongs to the other person — their device
  // publishes the key when they finish setting up an identity — so the message
  // has to say whose problem it is, or it reads as this device being broken.
  if (message.includes(NO_PEER_KEY)) {
    return 'This contact has not published an encryption key yet. Nothing can be sent to them until they open Nearside again on their device.';
  }

  // The file stopped being readable between the pick and the send. On Android a
  // gallery item can be a cloud placeholder, and a content URI's permission
  // does not always survive the app going to the background — both land here as
  // a DOMException with nothing but a name.
  if (
    name === 'NotReadableError' ||
    name === 'NotFoundError' ||
    name === 'SecurityError' ||
    /could not be read|file could not be read/i.test(message)
  ) {
    return 'That file could not be read from this device. If it lives in the cloud, open it in your gallery first so it downloads, then try again.';
  }

  // Sealing happens in one shot over the whole file, which is what the format
  // requires: a secretbox has one nonce and one tag. A phone that cannot spare
  // the buffer fails here rather than at the upload.
  if (name === 'RangeError' || /out of memory|allocation failed|invalid array length/i.test(message)) {
    return 'That file is too large to encrypt on this device. Send a shorter clip or a smaller photo.';
  }

  switch (code) {
    // PostgREST cannot see a table or a column: a migration in
    // supabase/migrations/apply-order.txt has not been applied to this project,
    // or the schema cache has not reloaded yet. Nothing the sender can do, but
    // saying so out loud is what stops it being read as a lost message.
    case 'PGRST204':
    case 'PGRST205':
    case '42703':
      return 'Attachments are not set up on the server yet (a database migration is missing).';
    // Table privileges, as opposed to a policy declining a row.
    case '42501':
      return 'This account is not allowed to send attachments here.';
    // The insert satisfied no policy. In this conversation that means the
    // friendship is gone, or was never accepted.
    case 'PGRST116':
    case '42P01':
      return 'The server would not accept this message for this conversation.';
    // A CHECK constraint. The bounds live in schema.sql and the message names
    // which one, so it is passed through rather than paraphrased.
    case '23514':
      return message.trim() ? `The server refused this attachment: ${message.trim()}` : fallback;
  }

  // A fetch that never reached the server. supabase-js does not retry writes —
  // a retried insert is a duplicate message — so this is a real failure and not
  // something the app is quietly working through.
  if (
    name === 'TypeError' ||
    name === 'AbortError' ||
    /failed to fetch|networkerror|load failed|network request failed/i.test(message)
  ) {
    return 'No connection to the server. Check your network and try again.';
  }

  return message.trim() || fallback;
}
