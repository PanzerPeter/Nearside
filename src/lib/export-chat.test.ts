import { describe, expect, it } from 'vitest';
import {
  formatTranscript,
  stampFor,
  transcriptFilename,
  transcriptNamer,
  type TranscriptRow,
} from './export-chat';

const ME = 'me';
const AT = new Date('2026-03-04T09:00:00Z');

function row(user_id: string, text: string, created_at: string): TranscriptRow {
  return { user_id, text, created_at };
}

const nameFor = (id: string) => (id === ME ? 'You' : 'Alice');

function transcript(rows: TranscriptRow[]) {
  return formatTranscript(rows, { title: 'Alice', nameFor, exportedAt: AT });
}

describe('stampFor', () => {
  it('renders a timestamp to the minute', () => {
    expect(stampFor('2026-03-04T09:05:00Z')).toMatch(/^2026-03-0[34] \d{2}:\d{2}$/);
  });

  it('hands back a stamp it cannot parse rather than writing "Invalid Date"', () => {
    expect(stampFor('not a date')).toBe('not a date');
  });
});

describe('transcriptFilename', () => {
  it('names the file after the conversation and the day', () => {
    expect(transcriptFilename('Alice', AT)).toBe('nearside-Alice-2026-03-04.txt');
  });

  it('takes out anything a filesystem would object to', () => {
    expect(transcriptFilename('Dinner :: Friday??', AT)).toBe(
      'nearside-Dinner-Friday-2026-03-04.txt'
    );
  });

  it('falls back to a name rather than producing none', () => {
    expect(transcriptFilename('///', AT)).toBe('nearside-conversation-2026-03-04.txt');
  });

  it('does not let a very long group title run away with the name', () => {
    const name = transcriptFilename('x'.repeat(200), AT);
    expect(name.length).toBeLessThan(100);
  });
});

describe('formatTranscript', () => {
  it('reads downwards, oldest first, from rows that arrive newest first', () => {
    const out = transcript([
      row(ME, 'second', '2026-03-02T11:00:00Z'),
      row('alice', 'first', '2026-03-02T10:00:00Z'),
    ]);
    expect(out.indexOf('first')).toBeLessThan(out.indexOf('second'));
  });

  it('names who wrote each line', () => {
    const out = transcript([row('alice', 'hello', '2026-03-02T10:00:00Z')]);
    expect(out).toContain('] Alice: hello');
  });

  it('leaves out a message with no words, and counts what it kept', () => {
    const out = transcript([
      row('alice', '', '2026-03-02T11:00:00Z'),
      row('alice', '   ', '2026-03-02T10:30:00Z'),
      row(ME, 'hello', '2026-03-02T10:00:00Z'),
    ]);
    expect(out).toContain('1 message\n');
    // Only the message line starts with a stamp; the header's own line does not.
    expect(out.split('\n').filter((l) => l.startsWith('['))).toHaveLength(1);
  });

  it('says in the file what the file does not contain', () => {
    const out = transcript([row(ME, 'hi', '2026-03-02T10:00:00Z')]);
    expect(out).toContain('what this device decrypted');
    expect(out).toContain('not included');
  });

  it('names the conversation at the top', () => {
    expect(transcript([])).toContain('Nearside — Alice');
  });

  it('produces a readable file for a conversation with nothing in it', () => {
    const out = transcript([]);
    expect(out).toContain('0 messages');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('keeps a multi-line message as the writer typed it', () => {
    const out = transcript([row(ME, 'one\ntwo', '2026-03-02T10:00:00Z')]);
    expect(out).toContain('You: one\ntwo');
  });

  it('is the same file twice for the same input', () => {
    const rows = [row(ME, 'hi', '2026-03-02T10:00:00Z')];
    expect(transcript(rows)).toBe(transcript(rows));
  });

  it('does not reorder the caller’s array', () => {
    const rows = [row(ME, 'b', '2026-03-02T11:00:00Z'), row(ME, 'a', '2026-03-02T10:00:00Z')];
    transcript(rows);
    expect(rows[0].text).toBe('b');
  });
});

describe('transcriptNamer', () => {
  it('uses the viewer’s own label for their own lines', () => {
    const name = transcriptNamer(ME, 'You', () => 'Somebody');
    expect(name(ME)).toBe('You');
    expect(name('alice')).toBe('Somebody');
  });
});
