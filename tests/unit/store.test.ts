import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  migrate,
  openStore,
  SCHEMA_VERSION,
  schemaVersion,
  StoreError,
  STORE_FILE,
} from '../../src/main/store'

/** The profile's database (#125): opened, migrated and closed against a temp file. */
describe('store', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nemesis-store-'))
    path = join(dir, STORE_FILE)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates the file at the current schema with the two tables', () => {
    const db = openStore(path)
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION)
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string
      }[]
    ).map((row) => row.name)
    expect(tables).toEqual(['bookmarks', 'history'])
    db.close()
    expect(db.isOpen).toBe(false)
  })

  it('opens an existing file again without migrating it twice, keeping its rows', () => {
    const first = openStore(path)
    first
      .prepare('INSERT INTO bookmarks (url, title, tags, created_at) VALUES (?, ?, ?, ?)')
      .run('https://example.com/', 'Example', 'a', 1)
    first.close()
    const second = openStore(path)
    expect(schemaVersion(second)).toBe(SCHEMA_VERSION)
    expect(second.prepare('SELECT COUNT(*) AS n FROM bookmarks').get()).toEqual({ n: 1 })
    second.close()
  })

  it('refuses a file from a newer build and leaves it as it was', () => {
    const db = new DatabaseSync(path)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    expect(() => migrate(db)).toThrow(StoreError)
    db.close()
    expect(() => openStore(path)).toThrow(/newer than this build/)
  })
})
