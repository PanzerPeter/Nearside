import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `android/` is Gradle output plus Capacitor's own vendored native-bridge.js.
  // None of it is ours to lint, and leaving it in makes `npm run lint` fail
  // with two errors on any machine that has run a Gradle build — the vendored
  // file carries `eslint-disable` comments for typescript-eslint rules that are
  // not loaded for plain .js.
  // `ios/` is the same story: Xcode/CocoaPods output plus the web bundle
  // `cap sync` copies into App/App/public.
  // `electron/` follows the same rule, but only for what the build writes:
  // `main.ts` and the two configs beside it are hand-written source and are
  // linted. Everything listed here is `cap sync` / electron-builder output —
  // the copied web bundle, the compiled main process, the generated plugin
  // manifest (which carries eslint-disable comments for rules that are not
  // loaded for plain .mjs), the vendored runtime and the packaged artifacts.
  {
    ignores: [
      'dist',
      'android/**',
      'ios/**',
      'electron/app/**',
      'electron/build/**',
      'electron/generated/**',
      'electron/vendor/**',
      'electron/dist/**',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // react-hooks 7 turned the React Compiler's rules on inside
      // `recommended`. Fourteen of the sixteen pass on this codebase as-is and
      // are worth having — `purity`, `immutability`, `set-state-in-render`,
      // `error-boundaries` and the memoization rules all now fail the build
      // rather than showing up as a re-render nobody can explain.
      ...reactHooks.configs.recommended.rules,

      // The two that don't pass, and why they are off rather than fixed.
      //
      // `refs` fires 27 times, every one of them on `ref={scroll.listRef}` —
      // a ref *passed* to an element after travelling out of a custom hook's
      // return object. The compiler cannot see through the object, so it reads
      // a plain hand-off as a read of `.current` during render. None of the
      // 27 is a real render-phase ref read, and a rule that is wrong every
      // time it speaks trains you to stop reading lint output.
      //
      // `set-state-in-effect` fires 51 times, and it is describing this app's
      // architecture rather than a defect: every realtime subscriber keys its
      // effect on `connection.ts`'s `generation` counter and sets state when
      // the refetch beside it lands (see CLAUDE.md, "Wake, generation, and the
      // polling fallback"). `useDegraded` is the shape in miniature — an
      // effect that syncs a timer to external socket health. The rule's advice
      // is to derive instead, which for a value that arrives from a socket is
      // not available.
      //
      // Both are left as a deliberate, recorded decision, not an oversight:
      // re-check them if the thread ever moves off effect-driven fetching.
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',

      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  }
);
