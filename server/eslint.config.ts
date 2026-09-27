import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
  {
    // Test files mock partial Prisma fixtures and Express req/res objects,
    // which requires occasional `any` casts.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // PRD-0002 §V5: "Event" means the charity event. Webhook code says "message".
    // Warn only — this must never fail CI.
    files: ['services/webhooks/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'warn',
        {
          // Declared names only (variables, functions, params, types, classes) —
          // not property keys, so wire fields such as `event_types` stay allowed.
          selector:
            ':matches(VariableDeclarator > Identifier.id, :function > Identifier.id, :function > Identifier.params, :function > AssignmentPattern.params > Identifier.left, TSTypeAliasDeclaration > Identifier.id, TSInterfaceDeclaration > Identifier.id, ClassDeclaration > Identifier.id)[name=/[Ee]vent/]',
          message:
            'Avoid "Event" in webhook identifiers; use "Message" (see CONTEXT.md). Wire strings like X-Webhook-Event are fine.',
        },
      ],
    },
  },
];
