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
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  }
);
