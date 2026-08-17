import { useSyncExternalStore } from 'react';
import { locale, onLocaleChange, t, type Locale, type MessageKey, type Vars } from '../lib/i18n';

/**
 * The translator, bound to the language in force.
 *
 * `useSyncExternalStore` rather than a context provider: the language lives in
 * a module (see `lib/i18n.ts`, which explains why), and this is the smallest
 * thing that makes a change to it repaint every screen holding a string —
 * including the ones under a modal that is currently on top.
 *
 * The returned function is the module's own `t` and never changes identity, so
 * it costs nothing in a dependency array. What re-renders the component is the
 * subscription, not a new closure.
 */
export function useT(): (key: MessageKey, vars?: Vars) => string {
  useLocale();
  return t;
}

/** The language in force, for the rare component that has to branch on it
 *  rather than look a string up — the language picker, mostly. */
export function useLocale(): Locale {
  return useSyncExternalStore(onLocaleChange, locale, locale);
}
