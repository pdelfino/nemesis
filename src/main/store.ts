import { DatabaseSync } from 'node:sqlite'

/**
 * The profile's database (#125): the history and the bookmarks, in one file
 * in the profile folder (`app.getPath('userData')`, #64), opened once at
 * startup and closed at quit. It is `node:sqlite`, the SQLite built into the
 * Node that Electron ships (Approach A of #125): no dependency, no install
 * script, and a synchronous API that fits the main process.
 *
 * The schema is versioned with SQLite's own `user_version`: each entry of
 * `MIGRATIONS` takes the file one version up, in a transaction, so a file
 * from an older build is brought forward on open and a file from a newer
 * build is refused rather than written in a shape it does not know.
 *
 * Only a URL and a title are ever stored for a page (#125, Do not touch):
 * never its content, and nothing from the `ephemeral` partition, which the
 * recorder in history.ts keeps out before a row is written.
 */

/** The file in the profile folder. */
export const STORE_FILE = 'nemesis.sqlite'

/** Each step takes the schema from its index to its index plus one. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE history (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    visited_at INTEGER NOT NULL,
    buffer TEXT NOT NULL,
    parent INTEGER REFERENCES history(id) ON DELETE SET NULL
  );
  CREATE INDEX history_by_time ON history(visited_at);
  CREATE INDEX history_by_url ON history(url);
  CREATE TABLE bookmarks (
    url TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  `,
]

/** The schema this build writes. */
export const SCHEMA_VERSION = MIGRATIONS.length

export class StoreError extends Error {
  override readonly name = 'StoreError'
}

/** The schema version a database is at. */
export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined
  return typeof row?.user_version === 'number' ? row.user_version : 0
}

/** Brings `db` up to `SCHEMA_VERSION`, one transaction per step. */
export function migrate(db: DatabaseSync): void {
  const at = schemaVersion(db)
  if (at > SCHEMA_VERSION) {
    throw new StoreError(
      `The profile's database is at schema ${at}, newer than this build's ${SCHEMA_VERSION}`,
    )
  }
  for (let version = at; version < SCHEMA_VERSION; version += 1) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[version] ?? '')
      db.exec(`PRAGMA user_version = ${version + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}

/** Opens the database at `path`, creating it when absent, and migrates it. */
export function openStore(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    migrate(db)
  } catch (error) {
    db.close()
    throw error
  }
  return db
}
