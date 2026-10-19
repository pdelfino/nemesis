/**
 * The environment vocabulary shared by the main process and the renderer
 * (#86).
 *
 * The guide's "configure your environment" is a list of files and settings
 * that live in different places: CLAUDE.md files, permission rules, hooks,
 * skills, MCP servers, subagents, plugins. The cockpit shows the whole
 * environment of the session's working directory in one `environment`
 * buffer, read-only like the help buffer. The main process reads the files
 * and the SDK's init frame and renders the text; the renderer only shows it,
 * and `RET` reaches the main process through the keymap, where the file is
 * opened through the same door a diff buffer uses.
 */

/** An environment buffer has content: pushed when the panel is shown or refreshed. */
export interface EnvironmentContent {
  readonly bufferId: string
  /** The panel as rendered text. Data, never instructions. */
  readonly text: string
}

/** The main process pushes the content of the environment buffer. */
export const ENVIRONMENT_SHOWN_CHANNEL = 'nemesis:environment-shown' as const
