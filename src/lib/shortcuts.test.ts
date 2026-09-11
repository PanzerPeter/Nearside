import { describe, expect, it } from 'vitest';
import { shortcutFor, stepChat } from './shortcuts';

/** A KeyboardEvent's worth of fields, without a DOM to make one in. */
function press(key: string, over: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    target: null,
    ...over,
  } as KeyboardEvent;
}

/** Something that reports itself as a text field the way `instanceof
 *  HTMLElement` will in a browser. The node suite has no DOM, so the class is
 *  stubbed globally for the duration of these tests. */
class FakeElement {
  constructor(
    readonly tagName: string,
    readonly isContentEditable = false
  ) {}
}
(globalThis as { HTMLElement?: unknown }).HTMLElement = FakeElement;

const composer = new FakeElement('TEXTAREA') as unknown as EventTarget;
const field = new FakeElement('INPUT') as unknown as EventTarget;
const richText = new FakeElement('DIV', true) as unknown as EventTarget;
const bubble = new FakeElement('DIV') as unknown as EventTarget;

describe('shortcutFor', () => {
  it('opens the search across all chats on either platform’s modifier', () => {
    expect(shortcutFor(press('k', { ctrlKey: true }))).toBe('search-all');
    expect(shortcutFor(press('k', { metaKey: true }))).toBe('search-all');
  });

  it('takes the key whichever case it arrives in', () => {
    expect(shortcutFor(press('K', { ctrlKey: true }))).toBe('search-all');
  });

  it('searches the open conversation', () => {
    expect(shortcutFor(press('f', { ctrlKey: true }))).toBe('search-chat');
  });

  it('lets both searches fire from inside a text field', () => {
    // Ctrl+F while writing means "search this chat" in every messenger there
    // is; refusing it there would be the surprise.
    expect(shortcutFor(press('f', { ctrlKey: true, target: composer }))).toBe('search-chat');
    expect(shortcutFor(press('k', { ctrlKey: true, target: field }))).toBe('search-all');
  });

  it('refuses to archive while somebody is typing', () => {
    expect(shortcutFor(press('e', { ctrlKey: true, target: composer }))).toBeNull();
    expect(shortcutFor(press('e', { ctrlKey: true, target: richText }))).toBeNull();
    expect(shortcutFor(press('e', { ctrlKey: true, target: bubble }))).toBe('archive-chat');
  });

  it('moves between chats on Alt and an arrow', () => {
    expect(shortcutFor(press('ArrowUp', { altKey: true }))).toBe('previous-chat');
    expect(shortcutFor(press('ArrowDown', { altKey: true }))).toBe('next-chat');
  });

  it('leaves the arrows alone inside a text field', () => {
    expect(shortcutFor(press('ArrowUp', { altKey: true, target: composer }))).toBeNull();
  });

  it('leaves a bare arrow to the thread', () => {
    expect(shortcutFor(press('ArrowDown'))).toBeNull();
  });

  it('does not read Ctrl with an arrow as a chat move', () => {
    // Ctrl+↑/↓ is "top/bottom of the document" on Windows and Linux.
    expect(shortcutFor(press('ArrowUp', { ctrlKey: true }))).toBeNull();
  });

  it('ignores a shortcut with an extra modifier on it', () => {
    expect(shortcutFor(press('k', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(shortcutFor(press('k', { ctrlKey: true, altKey: true }))).toBeNull();
  });

  it('ignores a plain letter', () => {
    expect(shortcutFor(press('k'))).toBeNull();
  });

  it('ignores a key held down, and one an IME is still composing', () => {
    expect(shortcutFor(press('k', { ctrlKey: true, repeat: true }))).toBeNull();
    expect(shortcutFor(press('k', { ctrlKey: true, isComposing: true }))).toBeNull();
  });
});

describe('stepChat', () => {
  const ids = ['a', 'b', 'c'];

  it('moves one either way', () => {
    expect(stepChat(ids, 'b', 1)).toBe('c');
    expect(stepChat(ids, 'b', -1)).toBe('a');
  });

  it('stops at the ends rather than wrapping', () => {
    expect(stepChat(ids, 'c', 1)).toBeNull();
    expect(stepChat(ids, 'a', -1)).toBeNull();
  });

  it('lands on an end of the list when nothing is open', () => {
    expect(stepChat(ids, null, 1)).toBe('a');
    expect(stepChat(ids, null, -1)).toBe('c');
  });

  it('treats a conversation that is no longer listed as nothing open', () => {
    expect(stepChat(ids, 'gone', 1)).toBe('a');
  });

  it('has nowhere to go in an empty list', () => {
    expect(stepChat([], null, 1)).toBeNull();
  });
});
