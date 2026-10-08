import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'demo/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ['client/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    // shadcn/ui primitives follow the documented upstream shadcn pattern of
    // co-exporting a cva() variants object alongside the component (e.g.
    // `export { Button, buttonVariants }`), which react-refresh flags as
    // breaking fast-refresh. This is upstream shadcn convention, not a
    // mistake, and will recur as more primitives are added — narrow the rule
    // here instead of tolerating a growing pile of warnings.
    files: ['client/src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true, allowExportNames: ['badgeVariants', 'buttonVariants'] },
      ],
    },
  },
  {
    files: ['**/*.mjs', '**/scripts/**'],
    languageOptions: { globals: globals.node },
  },
  prettier,
);
