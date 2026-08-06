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
  { ignores: ['dist', 'android/**'] },
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
