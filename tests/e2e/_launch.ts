import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication } from '@playwright/test'

/**
 * Launches the built app (out/) against a throwaway profile. The security
 * harness (#46) extends this with the mocked SDK and the fixture server.
 */
export async function launchNemesis(): Promise<ElectronApplication> {
  const userData = mkdtempSync(join(tmpdir(), 'nemesis-e2e-'))
  return electron.launch({
    args: ['.'],
    env: { ...process.env, NODE_ENV: 'test', NEMESIS_USER_DATA: userData },
  })
}
