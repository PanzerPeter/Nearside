import { useCallback, useRef, useState } from 'react';
import { clearDraft, getDraft, putDraft } from '../lib/drafts';

/**
 * The composer's text for one conversation, kept in `lib/drafts.ts`.
 *
 * The switch is handled during render rather than in an effect. `ChatRoom` is
 * not remounted when the selected friend changes, so an effect would paint one
 * frame of the previous conversation's draft under the new name before
 * correcting itself — which is the exact confusion this hook exists to remove.
 * Setting state while rendering is React's supported way to derive state from a
 * changed prop: the re-render happens before the browser paints anything.
 */
export function useDraft(key: string): {
  value: string;
  setValue: (next: string) => void;
  /** Sent: the conversation has no draft any more. */
  clear: () => void;
} {
  const [value, setValue] = useState(() => getDraft(key));
  const keyRef = useRef(key);

  if (keyRef.current !== key) {
    keyRef.current = key;
    setValue(getDraft(key));
  }

  const update = useCallback(
    (next: string) => {
      setValue(next);
      putDraft(keyRef.current, next);
    },
    []
  );

  const clear = useCallback(() => {
    setValue('');
    clearDraft(keyRef.current);
  }, []);

  return { value, setValue: update, clear };
}
