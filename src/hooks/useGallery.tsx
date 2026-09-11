// The conversation's pictures, made reachable from inside a message bubble.
//
// A context rather than props. The list belongs to the thread, and the only
// component that needs it is `MediaAttachment`, four levels down past
// `MessageThread` and `MessageBubble` — both of which would otherwise have to
// carry and re-pass a prop that means nothing to either of them.
//
// The default is an empty list, so an attachment rendered outside a thread —
// the pinned-media screen, a preview — simply has no neighbours and shows no
// arrows, rather than needing a provider it has no list to give.

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { galleryItems, type GalleryItem, type GalleryRow } from '../lib/gallery';

const GalleryContext = createContext<GalleryItem[]>([]);

interface GalleryProviderProps {
  /** The thread's rows, opened, in the order they are drawn. */
  messages: readonly GalleryRow[];
  children: ReactNode;
}

export function GalleryProvider({ messages, children }: GalleryProviderProps) {
  // Recomputed only when the rows change identity. Every attachment on screen
  // reads this, so a fresh array per render would re-run each of their memos on
  // every keystroke in the composer.
  const items = useMemo(() => galleryItems(messages), [messages]);
  return <GalleryContext.Provider value={items}>{children}</GalleryContext.Provider>;
}

// The provider and its consumer live together, the way useToast's and
// usePresence's do: a context is one contract, and splitting the two halves
// across files buys a fast-refresh warning's silence and nothing else.
// eslint-disable-next-line react-refresh/only-export-components
export function useGallery(): GalleryItem[] {
  return useContext(GalleryContext);
}
