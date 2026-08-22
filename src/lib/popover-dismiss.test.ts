import { describe, expect, it } from 'vitest';
import { dismissesOnScroll, type ContainerNode } from './popover-dismiss';

/** A node that contains exactly the nodes it is given. */
function node(...children: ContainerNode[]): ContainerNode {
  const self: ContainerNode = {
    contains: (other) => other === self || children.some((c) => c.contains(other)),
  };
  return self;
}

const leaf = () => node();

describe('dismissesOnScroll', () => {
  it('ignores a scroller that does not move the trigger', () => {
    // The message thread scrolling itself to the bottom because the peer sent
    // something, while the composer's emoji button sits still beneath it.
    const anchor = leaf();
    const panel = leaf();
    const thread = node(leaf());
    node(thread, anchor);
    expect(dismissesOnScroll({ target: thread, panel, anchor })).toBe(false);
  });

  it('dismisses when the scroller carries the trigger with it', () => {
    // A reaction picker anchored to a bubble inside the list.
    const anchor = leaf();
    const list = node(anchor);
    expect(dismissesOnScroll({ target: list, panel: leaf(), anchor })).toBe(true);
  });

  it('dismisses on a document scroll', () => {
    const anchor = leaf();
    const doc = node(anchor);
    expect(dismissesOnScroll({ target: doc, panel: leaf(), anchor })).toBe(true);
  });

  it('ignores a scroll inside the popover itself', () => {
    // Browsing the emoji list, whose scroller is a descendant of the panel —
    // and whose ancestors include the document, so the trigger test alone
    // would close it on the first flick.
    const emojiList = leaf();
    const panel = node(emojiList);
    const anchor = leaf();
    const doc = node(panel, anchor);
    expect(dismissesOnScroll({ target: emojiList, panel, anchor })).toBe(false);
    expect(dismissesOnScroll({ target: doc, panel, anchor })).toBe(true);
  });

  it('dismisses when the trigger is gone', () => {
    expect(dismissesOnScroll({ target: leaf(), panel: leaf(), anchor: null })).toBe(true);
  });

  it('ignores an event with no target', () => {
    expect(dismissesOnScroll({ target: null, panel: leaf(), anchor: leaf() })).toBe(false);
  });
});
