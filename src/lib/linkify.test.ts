import { describe, expect, it } from 'vitest';
import { linkify } from './linkify';

describe('linkify', () => {
  it('returns a single text segment when there is no URL', () => {
    expect(linkify('just talking')).toEqual([{ type: 'text', value: 'just talking' }]);
  });

  it('extracts an http URL', () => {
    expect(linkify('see https://example.com now')).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'link', value: 'https://example.com', href: 'https://example.com' },
      { type: 'text', value: ' now' },
    ]);
  });

  it('gives a bare www host an https scheme', () => {
    expect(linkify('www.example.com')).toEqual([
      { type: 'link', value: 'www.example.com', href: 'https://www.example.com' },
    ]);
  });

  it('does not swallow trailing sentence punctuation', () => {
    // The brief's literal expectation for this case omits the leading "go to "
    // text segment, which contradicts the "extracts an http URL" case just
    // above for the same word-URL-word shape. Corrected here to include it —
    // see task-14-report.md for the full justification.
    expect(linkify('go to https://example.com.')).toEqual([
      { type: 'text', value: 'go to ' },
      { type: 'link', value: 'https://example.com', href: 'https://example.com' },
      { type: 'text', value: '.' },
    ]);
  });

  it('keeps balanced parentheses inside the URL', () => {
    const url = 'https://en.wikipedia.org/wiki/Foo_(bar)';
    expect(linkify(url)).toEqual([{ type: 'link', value: url, href: url }]);
  });

  it('finds several URLs in one message', () => {
    const out = linkify('a https://one.test b http://two.test c');
    expect(out.filter((s) => s.type === 'link')).toHaveLength(2);
  });

  it('leaves a token that trims down to a bare prefix as text', () => {
    expect(linkify('www.!')).toEqual([{ type: 'text', value: 'www.!' }]);
  });

  it('refuses non-web schemes', () => {
    expect(linkify('javascript:alert(1)')).toEqual([
      { type: 'text', value: 'javascript:alert(1)' },
    ]);
  });
});
