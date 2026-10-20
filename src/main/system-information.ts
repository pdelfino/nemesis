/** What show-system-information reports (#173). */
export interface SystemInformation {
  readonly version: string
  /** The short commit the build came from, or null when none is known. */
  readonly commit: string | null
  readonly electron: string
  readonly chromium: string
  readonly node: string
  /** The macOS version, as Electron's getSystemVersion gives it. */
  readonly os: string
  readonly settingsPath: string
}

/**
 * The text for a bug report: versions and the settings file, nothing else.
 * The home folder is written as `~`, so no user name travels with the text.
 */
export function systemInformationText(info: SystemInformation, home: string): string {
  const shown = (path: string): string =>
    home.length > 0 && (path === home || path.startsWith(`${home}/`))
      ? `~${path.slice(home.length)}`
      : path
  return [
    `Nemesis ${info.version} (${info.commit ?? 'no commit known'})`,
    `Electron ${info.electron}`,
    `Chromium ${info.chromium}`,
    `Node ${info.node}`,
    `macOS ${info.os}`,
    `Settings file ${shown(info.settingsPath)}`,
  ].join('\n')
}
