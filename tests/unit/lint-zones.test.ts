import { ESLint } from 'eslint'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The layout in CLAUDE.md is a set of import zones the gate checks (#103):
// one forbidden import per zone is reported, one allowed import passes. The
// code is linted as text under a path inside the zone, with the repository's
// own config, so the test proves the config and not a copy of it.
const root = join(import.meta.dirname, '../..')
const eslint = new ESLint({ cwd: root, overrideConfigFile: join(root, 'eslint.config.mjs') })
const rule = '@typescript-eslint/no-restricted-imports'

async function zoneMessages(file: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath: join(root, file) })
  if (!result) throw new Error(`no lint result for ${file}`)
  return result.messages.filter((message) => message.ruleId === rule)
}

function imports(specifier: string) {
  return `import { x } from '${specifier}'\nexport { x }\n`
}

const zones = [
  {
    zone: 'src/shared/',
    file: 'src/shared/probe.ts',
    forbidden: [
      '../main/ipc',
      '../renderer/keys',
      '../preload/index',
      'electron',
      'node:fs',
      'path',
    ],
    allowed: ['./keys'],
    reference: 'CLAUDE.md Layout',
  },
  {
    zone: 'src/preload/',
    file: 'src/preload/probe.ts',
    forbidden: ['../main/ipc', '../renderer/keys', 'node:fs', '@codemirror/view', './sibling'],
    allowed: ['electron', '../shared/keys'],
    reference: 'SECURITY.org T1',
  },
  {
    zone: 'src/renderer/',
    file: 'src/renderer/probe.ts',
    forbidden: ['../main/ipc', '../preload/index'],
    allowed: ['../shared/keys', './theme', '@codemirror/view'],
    reference: 'SECURITY.org T1',
  },
  {
    zone: 'src/main/security/',
    file: 'src/main/security/probe.ts',
    forbidden: [
      '../agent/session',
      '../commands/registry',
      '../buffers',
      '../../renderer/keys',
      '../../preload/index',
    ],
    allowed: ['electron', 'node:path', '../../shared/keys', './permissions'],
    reference: 'CLAUDE.md Layout',
  },
  {
    zone: 'src/main/agent/',
    file: 'src/main/agent/probe.ts',
    forbidden: ['../../renderer/keys'],
    allowed: ['electron', '../../shared/agent', '../buffers', './session'],
    reference: 'CLAUDE.md Layout',
  },
]

describe('import zones (CLAUDE.md Layout)', () => {
  for (const { zone, file, forbidden, allowed, reference } of zones) {
    describe(zone, () => {
      for (const specifier of forbidden) {
        it(`reports an import from ${specifier}`, async () => {
          const messages = await zoneMessages(file, imports(specifier))
          expect(messages).toHaveLength(1)
          expect(messages[0]?.message).toContain(reference)
        })
      }
      for (const specifier of allowed) {
        it(`accepts an import from ${specifier}`, async () => {
          expect(await zoneMessages(file, imports(specifier))).toEqual([])
        })
      }
    })
  }

  it('lets a type-only import cross a zone, since it reaches no bundle', async () => {
    const source = "import type { X } from '../main/agent/events'\nexport type { X }\n"
    expect(await zoneMessages('src/shared/probe.ts', source)).toEqual([])
  })

  it('does not mistake a sibling module for a Node built-in', async () => {
    expect(await zoneMessages('src/shared/probe.ts', imports('./events'))).toEqual([])
  })
})
