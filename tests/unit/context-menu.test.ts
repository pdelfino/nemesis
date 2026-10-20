import { describe, expect, it } from 'vitest'
import type { AtPoint } from '../../src/main/commands/registry'
import {
  BOOKMARK_LINK_LABEL,
  contextMenuItems,
  COPY_LINK_LABEL,
  OPEN_LINK_LABEL,
  type ContextMenuActions,
  type ContextMenuItem,
} from '../../src/main/pages/context-menu'

// The page context menu (#180): the built-in link entries act on the link
// under the pointer, and a config entry runs its command with the AtPoint.

function recorder(): { readonly actions: ContextMenuActions; readonly calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    actions: {
      openNew: (url) => calls.push(['openNew', url]),
      copy: (url) => calls.push(['copy', url]),
      bookmark: (pageId, url) => calls.push(['bookmark', pageId, url]),
      run: (command, atPoint) => calls.push(['run', command, atPoint]),
    },
  }
}

function click(items: readonly ContextMenuItem[], label: string): void {
  const item = items.find((one) => one.type === 'normal' && one.label === label)
  if (item?.type !== 'normal') throw new Error(`No entry ${label}`)
  item.click()
}

const ON_LINK: AtPoint = Object.freeze({
  pageId: 'p1',
  pageUrl: 'https://example.test/',
  linkUrl: 'https://example.test/next',
  selection: null,
})

describe('the page context menu (#180)', () => {
  it('offers the link entries, then the config entries after a separator', () => {
    const { actions } = recorder()
    const items = contextMenuItems(ON_LINK, [{ label: 'Note link', command: 'note-link' }], actions)
    expect(items.map((item) => (item.type === 'normal' ? item.label : '-'))).toEqual([
      OPEN_LINK_LABEL,
      COPY_LINK_LABEL,
      BOOKMARK_LINK_LABEL,
      '-',
      'Note link',
    ])
    expect(items.every((item) => item.type === 'separator' || item.enabled)).toBe(true)
  })

  it('runs each built-in on the link, and a config entry with the AtPoint itself', () => {
    const { actions, calls } = recorder()
    const items = contextMenuItems(ON_LINK, [{ label: 'Note link', command: 'note-link' }], actions)
    for (const label of [OPEN_LINK_LABEL, COPY_LINK_LABEL, BOOKMARK_LINK_LABEL, 'Note link']) {
      click(items, label)
    }
    expect(calls).toEqual([
      ['openNew', 'https://example.test/next'],
      ['copy', 'https://example.test/next'],
      ['bookmark', 'p1', 'https://example.test/next'],
      ['run', 'note-link', ON_LINK],
    ])
  })

  it('greys the link entries off a link, keeps the config entries, and adds no separator alone', () => {
    const { actions, calls } = recorder()
    const offLink: AtPoint = { ...ON_LINK, linkUrl: null, selection: 'some words' }
    const bare = contextMenuItems(offLink, [], actions)
    expect(bare).toHaveLength(3)
    expect(bare.every((item) => item.type === 'normal' && !item.enabled)).toBe(true)
    click(bare, COPY_LINK_LABEL)
    expect(calls).toEqual([])
    const withEntry = contextMenuItems(offLink, [{ label: 'Quote', command: 'quote' }], actions)
    const quote = withEntry.at(-1)
    expect(quote).toMatchObject({ type: 'normal', label: 'Quote', enabled: true })
  })
})
