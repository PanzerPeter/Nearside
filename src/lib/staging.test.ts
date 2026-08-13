import { describe, expect, it } from 'vitest';
import { MEDIA_BATCH_LIMIT, MEDIA_MAX_BYTES } from './conversation';
import { stageFiles, type StagedMedia } from './staging';

function file(name: string, type: string, bytes = 8): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function image(name = 'a.jpg'): File {
  return file(name, 'image/jpeg');
}

function staged(...files: File[]): StagedMedia[] {
  return files.map((f, i) => ({ id: `id-${i}`, file: f, durationMs: null }));
}

describe('stageFiles', () => {
  it('appends picked images to what is already staged', () => {
    const result = stageFiles(staged(image('one.jpg')), [image('two.jpg'), image('three.jpg')]);
    expect(result.staged.map((s) => s.file.name)).toEqual(['one.jpg', 'two.jpg', 'three.jpg']);
    expect(result.error).toBeNull();
  });

  it('gives every staged item its own id, so the strip can key on it', () => {
    const result = stageFiles([], [image('one.jpg'), image('one.jpg')]);
    const [a, b] = result.staged;
    expect(a.id).not.toEqual(b.id);
  });

  it('refuses a file type that cannot be sent, and keeps the rest', () => {
    const result = stageFiles([], [image('ok.jpg'), file('notes.pdf', 'application/pdf')]);
    expect(result.staged.map((s) => s.file.name)).toEqual(['ok.jpg']);
    expect(result.error).toMatch(/notes\.pdf/);
  });

  it('refuses a file over the bucket limit, and keeps the rest', () => {
    const huge = file('huge.mp4', 'video/mp4', MEDIA_MAX_BYTES + 1);
    const result = stageFiles([], [image('ok.jpg'), huge]);
    expect(result.staged.map((s) => s.file.name)).toEqual(['ok.jpg']);
    expect(result.error).toMatch(/huge\.mp4/);
  });

  it('stops at the batch limit and says so', () => {
    const many = Array.from({ length: MEDIA_BATCH_LIMIT + 3 }, (_, i) => image(`${i}.jpg`));
    const result = stageFiles([], many);
    expect(result.staged).toHaveLength(MEDIA_BATCH_LIMIT);
    expect(result.error).toMatch(new RegExp(String(MEDIA_BATCH_LIMIT)));
  });

  it('counts what is already staged against the batch limit', () => {
    const already = staged(...Array.from({ length: MEDIA_BATCH_LIMIT }, (_, i) => image(`${i}.jpg`)));
    const result = stageFiles(already, [image('late.jpg')]);
    expect(result.staged).toHaveLength(MEDIA_BATCH_LIMIT);
    expect(result.staged.some((s) => s.file.name === 'late.jpg')).toBe(false);
  });

  // A recording is not part of a batch: it is the whole message, and the send
  // path gives only it a duration.
  it('replaces the queue when a voice recording is staged', () => {
    const result = stageFiles(staged(image('one.jpg'), image('two.jpg')), [
      file('voice.webm', 'audio/webm'),
    ]);
    expect(result.staged).toHaveLength(1);
    expect(result.staged[0].file.name).toEqual('voice.webm');
  });

  it('carries the recording length through', () => {
    const result = stageFiles([], [file('voice.webm', 'audio/webm')], 4200);
    expect(result.staged[0].durationMs).toEqual(4200);
  });

  it('leaves a picked image with no duration even when one is passed', () => {
    const result = stageFiles([], [image()], 4200);
    expect(result.staged[0].durationMs).toBeNull();
  });

  it('refuses to append to a staged recording rather than mixing kinds', () => {
    const recording = staged(file('voice.webm', 'audio/webm'));
    const result = stageFiles(recording, [image('late.jpg')]);
    expect(result.staged).toEqual(recording);
    expect(result.error).toMatch(/voice message/i);
  });

  it('reports nothing when nothing was picked', () => {
    const already = staged(image('one.jpg'));
    const result = stageFiles(already, []);
    expect(result.staged).toEqual(already);
    expect(result.error).toBeNull();
  });
});
