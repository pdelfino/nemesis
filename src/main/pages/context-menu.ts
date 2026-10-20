import type { AtPoint } from '../commands/registry'

/**
 * The context menu of a page buffer (#180), Nyxt's `ffi-add-context-menu-command`
 * with `url-at-point`: a few built-in entries on the link under the pointer,
 * then one per `nemesis.addContextMenuCommand(label, command)` of the config.
 *
 * The menu is the main process's native one, built from the `context-menu`
 * event's params (page-buffer.ts reads them into an `AtPoint`), so nothing
 * runs in the page to find what was clicked. A config entry runs its command
 * through the registry with `source: 'context-menu'` and the `AtPoint` on its
 * context: the link and the selection are page content, data the command
 * reads, never evaluated and never put into the agent's prompt. The command
 * keeps its own MCP class; the menu changes nothing of it.
 *
 * This module holds no Electron value: the cockpit turns the items into a
 * `Menu`, and the unit tests read them as they are.
 */

/** One config entry: the label the menu shows and the command it runs. */
export interface ContextMenuEntry {
  readonly label: string
  readonly command: string
}

/** A label longer than this is not one a menu can show. */
export const MAX_CONTEXT_LABEL = 80

/** What the built-in entries do, and how a config entry's command runs. */
export interface ContextMenuActions {
  /** The link in a new page buffer, made current, under the page policy. */
  openNew(url: string): void
  copy(url: string): void
  bookmark(pageId: string, url: string): void
  run(command: string, atPoint: AtPoint): void
}

export type ContextMenuItem =
  | { readonly type: 'separator' }
  | {
      readonly type: 'normal'
      readonly label: string
      readonly enabled: boolean
      click(): void
    }

/** The built-in labels, in the menu's order. */
export const OPEN_LINK_LABEL = 'Open link in new buffer'
export const COPY_LINK_LABEL = 'Copy link'
export const BOOKMARK_LINK_LABEL = 'Bookmark link'

/**
 * The menu for `atPoint`: the built-in link entries, enabled on a link only,
 * then the config's entries after a separator, each enabled wherever the menu
 * opens, since a command may read the selection or the page instead.
 */
export function contextMenuItems(
  atPoint: AtPoint,
  entries: readonly ContextMenuEntry[],
  actions: ContextMenuActions,
): readonly ContextMenuItem[] {
  const link = atPoint.linkUrl
  const onLink = (label: string, act: (url: string) => void): ContextMenuItem => ({
    type: 'normal',
    label,
    enabled: link !== null,
    click: () => {
      if (link !== null) act(link)
    },
  })
  const items: ContextMenuItem[] = [
    onLink(OPEN_LINK_LABEL, (url) => actions.openNew(url)),
    onLink(COPY_LINK_LABEL, (url) => actions.copy(url)),
    onLink(BOOKMARK_LINK_LABEL, (url) => actions.bookmark(atPoint.pageId, url)),
  ]
  if (entries.length > 0) items.push({ type: 'separator' })
  for (const entry of entries) {
    items.push({
      type: 'normal',
      label: entry.label,
      enabled: true,
      click: () => actions.run(entry.command, atPoint),
    })
  }
  return items
}
