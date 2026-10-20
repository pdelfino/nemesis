import type { PageEvent } from '../../shared/buffers'
import {
  encodeHintLabels,
  type DrawnLabel,
  type HintsAnswer,
  type HintsShowAnswer,
  type SemanticRole,
} from '../../shared/page-door'
import type { HintSettings } from '../settings'
import { formatRef, parseRef, type SemanticNode, type SemanticSnapshot } from './semantic'

/**
 * Hint mode on a page buffer (#123, study 03 "M4 needs" 2): `f` labels every
 * interactive node of the page's current snapshot that is in the viewport,
 * typing a label follows the link or focuses the field, `F` copies a link's
 * URL instead, and `C-g` leaves.
 *
 * - The targets are the snapshot's nodes (#122), by ref: the door's `hints`
 *   read numbers each element as the snapshot does, and a node the snapshot
 *   does not hold gets no label. So a hint and a `browser_click` by ref
 *   (ADR 0008) name the same element, and `activate` is the one operation
 *   both run.
 * - The labels are drawn by the page preload's overlay, a closed shadow root
 *   in the isolated world (ADR 0009), through the door's `hints-show`. Which
 *   label names which ref lives here, in main: the page can draw a label of
 *   its own, and typing it does nothing.
 * - A link is followed by opening its URL in the page buffer, under the page
 *   policy (#48, #52); any other target is clicked at its centre with input
 *   main synthesizes, which focuses a field and presses a button. A target
 *   whose document is gone (the page navigated) is refused.
 *
 * Nothing here touches Electron: the snapshot, the door, the page buffers and
 * the clipboard come in through `PageHintsOptions`.
 */

/** What a typed label does: follow (or focus) its target, or copy the target's URL. */
export type HintAction = 'follow' | 'copy' | 'bookmark'

/** One labelled target. */
export interface HintTarget {
  readonly label: string
  readonly ref: string
  readonly role: SemanticRole
  /** A link's absolute URL as the page reported it; empty on other roles. */
  readonly href: string
  /** In CSS pixels of the viewport, as the `hints` read found it. */
  readonly rect: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
}

export interface PageHintsOptions {
  /** The page's semantic view (#122). */
  readonly semantic: {
    snapshot(pageId: string): Promise<SemanticSnapshot>
    resolve(ref: string): { readonly pageId: string } | null
  }
  /** The door's `hints` read for a page buffer. */
  readonly read: (pageId: string) => Promise<HintsAnswer>
  /** The door's `hints-show` draw for a page buffer; no labels clears the overlay. */
  readonly show: (pageId: string, args: readonly number[]) => Promise<HintsShowAnswer>
  /** The `hints` settings, read at each `f`, so a reload-config's are the next one's. */
  readonly settings: () => HintSettings
  /** Puts `hint` mode in front of a page's modes, or takes it off. */
  readonly mode: (pageId: string, on: boolean) => void
  /** Opens a URL in the page buffer, under the page policy. */
  readonly open: (pageId: string, url: string) => Promise<unknown>
  /** A click at a point of the page's viewport, synthesized in main. */
  readonly click: (pageId: string, x: number, y: number) => void
  /** The system clipboard's text. */
  readonly copy: (text: string) => void
  /** Keeps a link of the page as a bookmark (#175); says why it did not on its own. */
  readonly bookmark?: (pageId: string, url: string) => void
  readonly notify: (text: string) => void
  /** Every page's event stream: a committed navigation ends hint mode on that page. */
  readonly events: (listener: (event: PageEvent) => void) => unknown
}

interface Hinting {
  readonly action: HintAction
  readonly targets: readonly HintTarget[]
  typed: string
  /** Where the overlay last said it drew each label, in the viewport. */
  drawn: readonly DrawnLabel[]
}

/**
 * Labels for `count` targets: every label the same length, the shortest the
 * alphabet allows up to `maxLength`, so no label is a prefix of another and
 * a label is chosen the moment it is typed whole. Past what that length can
 * name, the targets get no label: fewer labels than `count` come back.
 */
export function hintLabels(count: number, alphabet: string, maxLength: number): readonly string[] {
  const characters = [...alphabet]
  const base = characters.length
  if (count <= 0 || base < 2 || maxLength < 1) return []
  let length = 1
  while (length < maxLength && base ** length < count) length += 1
  const total = Math.min(count, base ** length)
  const labels: string[] = []
  for (let index = 0; index < total; index += 1) {
    let label = ''
    let rest = index
    for (let place = 0; place < length; place += 1) {
      label = (characters[rest % base] ?? '') + label
      rest = Math.floor(rest / base)
    }
    labels.push(label)
  }
  return labels
}

/** Every node of a tree, depth first. */
function flatten(nodes: readonly SemanticNode[]): SemanticNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)])
}

/**
 * The targets of one `f` or `F`: the elements the `hints` read found that the
 * snapshot also holds, in the read's order, each with the next label. `copy`
 * labels links only, since nothing else has a URL to copy.
 */
export function hintTargets(
  snapshot: SemanticSnapshot,
  answer: HintsAnswer,
  action: HintAction,
  settings: HintSettings,
): readonly HintTarget[] {
  const byElement = new Map<number, { readonly ref: string; readonly role: SemanticRole }>()
  let document: number | null = null
  for (const node of flatten(snapshot.nodes)) {
    const parsed = parseRef(node.ref)
    if (parsed === null) continue
    document = parsed.document
    byElement.set(parsed.element, { ref: node.ref, role: node.role })
  }
  if (document === null) return []
  const found = answer.nodes.flatMap((node) => {
    const known = byElement.get(node.id)
    if (known === undefined) return []
    if (action !== 'follow' && node.href.length === 0) return []
    return [{ node, ref: formatRef(document, node.id), role: known.role }]
  })
  const labels = hintLabels(found.length, settings.alphabet, settings.maxLength)
  return found.slice(0, labels.length).map(({ node, ref, role }, index) => ({
    label: labels[index] ?? '',
    ref,
    role,
    href: node.href,
    rect: { x: node.x, y: node.y, width: node.width, height: node.height },
  }))
}

export class PageHints {
  private readonly hinting = new Map<string, Hinting>()

  constructor(private readonly options: PageHintsOptions) {
    // A new document has no overlay and none of the old refs: the mode ends.
    options.events((event) => {
      if (event.type === 'committed' && this.hinting.delete(event.pageId)) {
        options.mode(event.pageId, false)
      }
    })
  }

  /** Whether a page has labels up. */
  active(pageId: string): boolean {
    return this.hinting.has(pageId)
  }

  /** The labelled targets of a page, for the spec; empty when none are up. */
  targets(pageId: string): readonly HintTarget[] {
    return this.hinting.get(pageId)?.targets ?? []
  }

  /** The overlay's last report of the labels it drew on a page, for the spec. */
  drawn(pageId: string): readonly DrawnLabel[] {
    return this.hinting.get(pageId)?.drawn ?? []
  }

  /** `f` or `F`: labels over the page's targets, and `hint` mode on. */
  async start(pageId: string, action: HintAction): Promise<void> {
    if (this.hinting.has(pageId)) await this.quit(pageId)
    let snapshot: SemanticSnapshot
    let answer: HintsAnswer
    try {
      snapshot = await this.options.semantic.snapshot(pageId)
      answer = await this.options.read(pageId)
    } catch (error) {
      // The door's and the snapshot's errors are main's own words, never the page's.
      this.options.notify(`No hints: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const targets = hintTargets(snapshot, answer, action, this.options.settings())
    const first = targets[0]
    if (first === undefined) {
      this.options.notify(
        action === 'follow' ? 'No hints on this page' : `No links to ${action} here`,
      )
      return
    }
    if (this.options.semantic.resolve(first.ref) === null) {
      throw new Error('The page navigated while its hints were read')
    }
    const shown = await this.options.show(pageId, encodeHintLabels(this.labelsOf(targets)))
    this.hinting.set(pageId, { action, targets, typed: '', drawn: shown.labels })
    this.options.mode(pageId, true)
  }

  /**
   * One key of a label. A key no label continues with is ignored; the last
   * key of a label ends the mode and runs the action on its target; any other
   * narrows the overlay to the labels that still match.
   */
  async type(pageId: string, key: string): Promise<void> {
    const state = this.hinting.get(pageId)
    if (state === undefined || key.length !== 1) return
    const typed = state.typed + key
    const matching = state.targets.filter((target) => target.label.startsWith(typed))
    if (matching.length === 0) return
    state.typed = typed
    const chosen = matching.find((target) => target.label === typed)
    if (chosen !== undefined) {
      await this.quit(pageId)
      await this.activate(pageId, chosen, state.action)
      return
    }
    const shown = await this.options.show(pageId, encodeHintLabels(this.labelsOf(matching)))
    if (this.hinting.get(pageId) === state) state.drawn = shown.labels
  }

  /** `C-g`: the labels come down and the mode ends. */
  async quit(pageId: string): Promise<void> {
    if (!this.hinting.delete(pageId)) return
    this.options.mode(pageId, false)
    await this.options.show(pageId, []).catch(() => undefined)
  }

  /**
   * The action on one target, by ref: a link's URL opened in the page or
   * copied, any other target clicked at its centre. A ref whose document is
   * gone is refused.
   */
  async activate(pageId: string, target: HintTarget, action: HintAction): Promise<void> {
    if (this.options.semantic.resolve(target.ref)?.pageId !== pageId) {
      this.options.notify('The page navigated; that hint is gone')
      return
    }
    if (action === 'bookmark') {
      if (target.href.length === 0) {
        this.options.notify('That element has no URL to bookmark')
        return
      }
      this.options.bookmark?.(pageId, target.href)
      return
    }
    if (action === 'copy') {
      if (target.href.length === 0) {
        this.options.notify('That element has no URL to copy')
        return
      }
      this.options.copy(target.href)
      // The URL is the page's and can carry a secret: the notice does not repeat it.
      this.options.notify("Copied the link's URL")
      return
    }
    if (target.role === 'link' && target.href.length > 0) {
      await this.options.open(pageId, target.href)
      return
    }
    const { x, y, width, height } = target.rect
    this.options.click(pageId, x + width / 2, y + height / 2)
  }

  private labelsOf(targets: readonly HintTarget[]): { id: number; label: string }[] {
    return targets.map((target) => ({
      id: parseRef(target.ref)?.element ?? 0,
      label: target.label,
    }))
  }
}
