import { builtinModules } from 'node:module'

import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// Import zones: the layout in CLAUDE.md as rules the gate checks (#103).
// Patterns are gitignore-style, so a bare Node name is anchored with a leading
// slash: 'events' alone would also match a sibling './events'. Type-only
// imports are erased at compile time and pull nothing into a bundle, so
// allowTypeImports lets them through; the runtime boundary is what the zone
// guards.
const nodeBuiltins = [
  'node:*',
  ...builtinModules.filter((name) => !name.startsWith('node:')).map((name) => `/${name}`),
]

function zone(patterns) {
  return {
    '@typescript-eslint/no-restricted-imports': [
      'error',
      { patterns: patterns.map((pattern) => ({ allowTypeImports: true, ...pattern })) },
    ],
  }
}

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      'release/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              importNames: ['remote'],
              message: 'The remote module is a sandbox escape. SECURITY.org T1.',
            },
          ],
        },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Repository scripts run under plain Node, outside any tsconfig.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  },
  {
    // The renderer never touches Node or Electron directly. SECURITY.org T1.
    files: ['src/renderer/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'node:*', 'fs', 'path', 'child_process'],
              message: 'No Node or Electron in the renderer.',
            },
          ],
        },
      ],
      'no-restricted-globals': ['error', 'require', 'process'],
    },
  },
  {
    // Shared code runs in the renderer: types and IPC schemas only.
    files: ['src/shared/**/*.ts'],
    rules: zone([
      {
        group: [
          '../main',
          '../main/**',
          '../renderer',
          '../renderer/**',
          '../preload',
          '../preload/**',
        ],
        message:
          'src/shared/ is types and schemas shared by main and renderer; it imports no process code (CLAUDE.md Layout).',
      },
      {
        group: ['electron', ...nodeBuiltins],
        message:
          'src/shared/ runs in the renderer, so no Electron or Node (CLAUDE.md Layout, SECURITY.org T1).',
      },
    ]),
  },
  {
    // The bridge is minimal: Electron and the shared contract, nothing else.
    files: ['src/preload/**/*.ts'],
    rules: zone([
      {
        regex: '^(?!electron$)(?!\\.\\./shared/[^/]+$).*',
        message:
          'src/preload/ is a minimal contextBridge surface: only electron and ../shared (CLAUDE.md Layout, SECURITY.org T1).',
      },
    ]),
  },
  {
    // On top of the Node and Electron ban above: no main or preload code either.
    files: ['src/renderer/**/*.ts'],
    rules: zone([
      {
        group: ['../main', '../main/**', '../preload', '../preload/**'],
        message:
          'The renderer never imports main or preload code (CLAUDE.md Layout, SECURITY.org T1).',
      },
    ]),
  },
  {
    // Policy depends on Electron and shared types only.
    files: ['src/main/security/**/*.ts'],
    rules: zone([
      {
        group: [
          '../agent',
          '../agent/**',
          '../commands',
          '../commands/**',
          '../buffers',
          '../buffers/**',
          '../../renderer',
          '../../renderer/**',
          '../../preload',
          '../../preload/**',
        ],
        message:
          'src/main/security/ is policy: Electron and shared types only, never the agent, commands, buffers, renderer or preload (CLAUDE.md Layout).',
      },
    ]),
  },
  {
    // ADR 0005: no hook reaches the permission path. Types of the agent's
    // events cross, as every zone lets a type through; nothing else does.
    files: ['src/main/hooks.ts'],
    rules: zone([
      {
        group: [
          './agent',
          './agent/**',
          './security',
          './security/**',
          '../preload',
          '../preload/**',
        ],
        message:
          'src/main/hooks.ts never reaches the agent, security or preload at run time (ADR 0005).',
      },
    ]),
  },
  {
    files: ['src/main/agent/**/*.ts'],
    rules: zone([
      {
        group: ['../../renderer', '../../renderer/**'],
        message: 'src/main/agent/ never imports the renderer (CLAUDE.md Layout).',
      },
    ]),
  },
)
