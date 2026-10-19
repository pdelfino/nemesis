import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CATALOG,
  CATALOG_VERSION,
  EVENTS_RESOURCE,
  PAGE_FEEDS,
  PAGE_RESOURCES,
} from '../../src/main/mcp/catalog'

/** docs/mcp.org (#144): a catalog row without its line in the doc fails the gate. */
const doc = readFileSync(join(__dirname, '..', '..', 'docs', 'mcp.org'), 'utf8')
const rows = doc.split('\n').filter((line) => line.startsWith('|'))

function cells(row: string): string[] {
  return row
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim())
}

describe('docs/mcp.org', () => {
  it.each(CATALOG.map((tool) => [tool.name, tool.confirmation] as const))(
    'lists %s in a table row with its class %s',
    (name, confirmation) => {
      const row = rows.find((line) => cells(line)[0] === `=${name}=`)
      expect(row, `no table row for ${name}`).toBeDefined()
      expect(cells(row ?? '')[1]).toBe(confirmation)
    },
  )

  it('names no tool the catalog lacks', () => {
    const known = new Set(CATALOG.map((tool) => tool.name))
    const tools = rows
      .map((line) => cells(line)[0] ?? '')
      .filter((cell) => /^=(?:cockpit|browser)_[a-z_]+=$/.test(cell))
      .map((cell) => cell.slice(1, -1))
    expect(tools.filter((name) => !known.has(name))).toEqual([])
  })

  it('has the events resource and the three feeds', () => {
    expect(doc).toContain(EVENTS_RESOURCE.uri)
    for (const feed of PAGE_FEEDS) expect(doc).toContain(PAGE_RESOURCES[feed].uriTemplate)
  })

  it('states the catalog version', () => {
    expect(doc).toContain(`The current version is ${CATALOG_VERSION}.`)
  })

  it('is linked from README.org and has no em-dash', () => {
    const readme = readFileSync(join(__dirname, '..', '..', 'README.org'), 'utf8')
    expect(readme).toContain('docs/mcp.org')
    expect(doc).not.toContain('—')
  })
})
