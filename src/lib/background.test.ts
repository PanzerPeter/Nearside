import { describe, expect, it } from 'vitest';
import {
  MAX_BACKGROUND_BYTES,
  backgroundPath,
  describeWriteError,
  validateBackgroundFile,
} from './background';

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';

function file(name: string, type: string, size = 1): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe('backgroundPath', () => {
  it('namespaces the file under the order-independent conversation folder', () => {
    expect(backgroundPath(B, A, 'png')).toMatch(
      new RegExp(`^${A}_${B}/bg-[0-9a-f-]{36}\\.png$`)
    );
  });

  it('never reuses a name, so a replacement cannot collide with the old object', () => {
    expect(backgroundPath(A, B, 'png')).not.toBe(backgroundPath(A, B, 'png'));
  });

  it('gives each participant a distinct object in the shared folder', () => {
    // Both users' backgrounds live in the same conversation folder; only the
    // uuid keeps A's file from standing on B's.
    expect(backgroundPath(A, B, 'png')).not.toBe(backgroundPath(B, A, 'png'));
  });
});

describe('validateBackgroundFile', () => {
  it('accepts a normal image', () => {
    expect(validateBackgroundFile(file('bg.png', 'image/png'))).toBeNull();
  });

  it('rejects video even though the bucket allows it', () => {
    expect(validateBackgroundFile(file('clip.mp4', 'video/mp4'))).toMatch(/image/i);
  });

  it('rejects a non-media file', () => {
    expect(validateBackgroundFile(file('notes.pdf', 'application/pdf'))).toMatch(/image/i);
  });

  it('rejects an image past the size cap', () => {
    const tooBig = file('huge.png', 'image/png', MAX_BACKGROUND_BYTES + 1);
    expect(validateBackgroundFile(tooBig)).toMatch(/smaller than/i);
  });

  it('accepts an image exactly at the cap', () => {
    const exact = file('edge.png', 'image/png', MAX_BACKGROUND_BYTES);
    expect(validateBackgroundFile(exact)).toBeNull();
  });
});

describe('describeWriteError', () => {
  it('names the setup problem when the table is not in the schema cache', () => {
    const message = describeWriteError({
      code: 'PGRST205',
      message: "Could not find the table 'public.chat_backgrounds' in the schema cache",
    });
    expect(message).toMatch(/not set up/i);
  });

  it('names the privilege problem separately from a policy denial', () => {
    const denied = describeWriteError({
      code: '42501',
      message: 'permission denied for table chat_backgrounds',
    });
    expect(denied).toMatch(/no permission/i);
    expect(denied).not.toBe(describeWriteError({ code: 'PGRST116', message: '' }));
  });

  it('falls through to the server message rather than guessing', () => {
    expect(
      describeWriteError({ code: '23514', message: 'violates check constraint "ordered_pair"' })
    ).toMatch(/ordered_pair/);
  });

  it('has a fallback when the server sent no usable text', () => {
    expect(describeWriteError({ code: 'XX000', message: '   ' })).toMatch(/could not save/i);
    expect(describeWriteError(null)).toMatch(/could not save/i);
  });
});
