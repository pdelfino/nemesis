import { describe, expect, it } from 'vitest'
import { systemInformationText, type SystemInformation } from '../../src/main/system-information'

const info: SystemInformation = {
  version: '0.1.0',
  commit: 'abc1234',
  electron: '44.9.1',
  chromium: '140.0.0.0',
  node: '24.1.0',
  os: '15.0',
  settingsPath: '/Users/someone/Library/Application Support/Nemesis/settings.json',
}

describe('systemInformationText (#173)', () => {
  it('names the version, the commit, the runtimes and the settings file', () => {
    const text = systemInformationText(info, '/Users/someone')
    expect(text).toContain('Nemesis 0.1.0 (abc1234)')
    expect(text).toContain('Electron 44.9.1')
    expect(text).toContain('Chromium 140.0.0.0')
    expect(text).toContain('Node 24.1.0')
    expect(text).toContain('macOS 15.0')
    expect(text).toContain('~/Library/Application Support/Nemesis/settings.json')
  })

  it('carries no home path', () => {
    expect(systemInformationText(info, '/Users/someone')).not.toContain('/Users/someone')
  })

  it('says so when no commit is known', () => {
    expect(systemInformationText({ ...info, commit: null }, '/Users/someone')).toContain(
      'no commit known',
    )
  })
})
