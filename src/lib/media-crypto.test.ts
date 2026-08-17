import { describe, expect, it } from 'vitest';
import { openFile, sealFile } from './media-crypto';

describe('media encryption', () => {
  it('round-trips bytes', async () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 250, 251]);
    const { blob, key } = await sealFile(original);
    const sealedBytes = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(sealedBytes)).not.toEqual(Array.from(original));
    expect(Array.from(await openFile(sealedBytes, key))).toEqual(Array.from(original));
  });

  it('uses a different key for every file', async () => {
    const a = await sealFile(new Uint8Array([1]));
    const b = await sealFile(new Uint8Array([1]));
    expect(Array.from(a.key)).not.toEqual(Array.from(b.key));
  });

  it('refuses a tampered file', async () => {
    const { blob, key } = await sealFile(new Uint8Array([1, 2, 3]));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    bytes[bytes.length - 1] ^= 1;
    await expect(openFile(bytes, key)).rejects.toThrow();
  });

  it('announces nothing about what the file is', async () => {
    // A sealed JPEG served as image/jpeg tells anyone reading the bucket what
    // it is. The blob's type is what the upload's contentType is taken from.
    const { blob } = await sealFile(new Uint8Array([0xff, 0xd8, 0xff]));
    expect(blob.type).toBe('application/octet-stream');
  });

  it('reads the nonce and the body as views, without copying the file', async () => {
    // Both halves are handed to libsodium as `subarray` views rather than
    // copies, which is only safe if their offsets are honoured. A fixture that
    // is itself a view over a larger buffer is what catches an offset being
    // dropped: an implementation that ignored one would seal fine here and
    // fail on every real attachment.
    const original = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const { blob, key } = await sealFile(original);

    const padded = new Uint8Array(blob.size + 40);
    padded.set(new Uint8Array(await blob.arrayBuffer()), 24);
    const view = padded.subarray(24, 24 + blob.size);

    expect(Array.from(await openFile(view, key))).toEqual(Array.from(original));
  });

  it('seals a file large enough to cross a chunk boundary', async () => {
    // Every other fixture here is a handful of bytes; a length bug would sail
    // through all of them. Same trap the eight-byte body fixtures set.
    // Filled by hand rather than with getRandomValues, which refuses anything
    // over 65536 bytes — and the point of this fixture is to be bigger than
    // the small ones, not to be random.
    const original = new Uint8Array(64 * 1024 + 7);
    for (let i = 0; i < original.length; i++) original[i] = (i * 31 + 7) & 0xff;
    const { blob, key } = await sealFile(original);
    const opened = await openFile(new Uint8Array(await blob.arrayBuffer()), key);
    expect(opened.length).toBe(original.length);
    expect(Array.from(opened.slice(-16))).toEqual(Array.from(original.slice(-16)));
  });
});
