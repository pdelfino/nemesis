import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, test, type Page } from './_test'
import { fixtureServer, launchNemesis } from './security/_harness'

/**
 * The MCP page tier, acting (#140, ADR 0008): a client outside the app,
 * through bin/nemesis-mcp, acts on a real page buffer over the acting
 * fixture, each call after its own yes in the palette, whose line names the
 * client, the tool, the page's origin and the client's element words. Input
 * is synthesized by main: the link is followed, the field takes the text
 * (the fixture echoes it), the form submits only after the yes, the hover
 * fires `mouseover`, the box is dragged onto its zone, and a screenshot of
 * a button is a PNG of the button's size. A password field is refused before
 * any question, and a ref of the page the click left is stale.
 */

const SHIM = join(process.cwd(), 'bin', 'nemesis-mcp')

type Result = Awaited<ReturnType<Client['callTool']>>

interface Item {
  readonly type: string
  readonly text?: string
  readonly data?: string
  readonly mimeType?: string
}

function items(result: Result): Item[] {
  return result.content as Item[]
}

function texts(result: Result): string[] {
  return items(result).map((item) => item.text ?? '')
}

/** The ref of the snapshot line for `role` named `name`. */
function refOf(block: string, role: string, name: string): string {
  const match = new RegExp(`\\[(d\\d+e\\d+)\\] ${role} "${name}"`).exec(block)
  if (match?.[1] === undefined) throw new Error(`No ${role} "${name}" in the snapshot:\n${block}`)
  return match[1]
}

/** Types into the open palette until `label` is the highlighted candidate, then picks it. */
async function pick(window: Page, label: string): Promise<void> {
  await expect(window.locator('#palette-input .cm-content')).toBeFocused()
  await window.keyboard.type(label)
  await expect
    .poll(() =>
      window
        .locator('#palette-candidates li[aria-selected="true"]')
        .evaluate((item) => item.firstChild?.textContent ?? ''),
    )
    .toBe(label)
  await window.keyboard.press('Enter')
}

test('a client clicks, types, submits, hovers, drags and captures, each after its own yes', async () => {
  const fixtures = await fixtureServer()
  const nemesis = await launchNemesis()
  const { window } = nemesis
  const client = new Client({ name: 'e2e-act-client', version: '1.0.0' })
  try {
    const buffer = await nemesis.openPageBuffer(fixtures.secureUrl('mcp-act.html'))
    expect(buffer.loadError).toBeNull()
    await expect(buffer.page).toHaveTitle('mcp-act')
    const page = buffer.page
    const pageId = buffer.ids?.bufferId
    if (pageId === undefined) throw new Error('The page buffer has no ids')

    const socket = join(nemesis.userData, 'mcp.sock')
    await expect.poll(() => existsSync(socket)).toBe(true)
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [SHIM, '--socket', socket] }),
    )
    const snapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} })
    const block = texts(snapshot)[1] ?? ''
    const refs = {
      next: refOf(block, 'link', 'Next page'),
      name: refOf(block, 'textbox', 'Name'),
      query: refOf(block, 'textbox', 'Query'),
      secret: refOf(block, 'textbox', 'Password'),
      hover: refOf(block, 'button', 'Hover me'),
      shot: refOf(block, 'button', 'Shot'),
      box: refOf(block, 'button', 'Box'),
      zone: refOf(block, 'button', 'Zone'),
    }

    const on = `on ${fixtures.httpsOrigin}`
    const prompt = window.locator('#palette-prompt')
    /** One call: its question is `line`, the yes is given, and the result has no error. */
    const allowed = async (
      name: string,
      args: Record<string, unknown>,
      line: string,
    ): Promise<Result> => {
      const call = client.callTool({ name, arguments: args })
      await expect(prompt).toHaveText(`e2e-act-client asks ${name} ${on}: ${line}`)
      await pick(window, 'Allow this one call')
      const result = await call
      expect(result.isError, `${name} ${texts(result).join(' ')}`).toBeFalsy()
      return result
    }

    // The human types secrets: refused before anyone is asked.
    const secret = await client.callTool({
      name: 'browser_type',
      arguments: { element: 'Password', ref: refs.secret, text: 'hunter2' },
    })
    expect(secret.isError).toBe(true)
    expect(texts(secret)).toEqual(['masked field: the human types it'])
    await expect(prompt).toBeHidden()
    expect(await page.locator('#secret').inputValue()).toBe('')

    // Typing: the fixture reads the value back.
    const typed = await allowed(
      'browser_type',
      { element: 'the name field', ref: refs.name, text: 'Ada Lovelace' },
      `type "Ada Lovelace" (12 characters) into "the name field" in ${pageId}?`,
    )
    expect(typed.structuredContent).toEqual({
      page: pageId,
      origin: fixtures.httpsOrigin,
      ref: refs.name,
      submitted: false,
    })
    await expect(page.locator('#echo')).toHaveText('Ada Lovelace')

    // Submitting: a no submits nothing; the yes does.
    const submitLine = `type "shoes" (5 characters) into "the query" in ${pageId}, then press Enter to submit it?`
    const submit = { element: 'the query', ref: refs.query, text: 'shoes', submit: true }
    const refused = client.callTool({ name: 'browser_type', arguments: submit })
    await expect(prompt).toHaveText(`e2e-act-client asks browser_type ${on}: ${submitLine}`)
    await expect(page.locator('#submitted')).toHaveText('not submitted')
    await pick(window, 'Refuse')
    expect((await refused).isError).toBe(true)
    await expect(page.locator('#submitted')).toHaveText('not submitted')
    expect(await page.locator('#query').inputValue()).toBe('')
    const submitted = await allowed('browser_type', submit, submitLine)
    expect(submitted.structuredContent).toMatchObject({ submitted: true })
    await expect(page.locator('#submitted')).toHaveText('submitted shoes')

    // Hovering fires the fixture's mouseover.
    await allowed(
      'browser_hover',
      { element: 'the Hover me button', ref: refs.hover },
      `hover over "the Hover me button" in ${pageId}?`,
    )
    await expect(page.locator('#hovered')).toHaveText('hovered')

    // Dragging moves the box onto its zone, centre to centre.
    await allowed(
      'browser_drag',
      { startElement: 'the box', startRef: refs.box, endElement: 'the zone', endRef: refs.zone },
      `drag "the box" onto "the zone" in ${pageId}?`,
    )
    const centre = (id: string): Promise<{ x: number; y: number }> =>
      page.locator(id).evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      })
    const zone = await centre('#zone')
    const box = await centre('#box')
    expect(Math.abs(box.x - zone.x)).toBeLessThanOrEqual(2)
    expect(Math.abs(box.y - zone.y)).toBeLessThanOrEqual(2)

    // A screenshot of the button is a PNG of the button's size.
    const shot = await allowed(
      'browser_screenshot',
      { ref: refs.shot },
      `capture the element ${refs.shot} of ${pageId} as an image, secret fields as the page draws them?`,
    )
    const image = items(shot).find((item) => item.type === 'image')
    expect(image?.mimeType).toBe('image/png')
    const png = Buffer.from(image?.data ?? '', 'base64')
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
    const scale = await page.evaluate(
      () => (globalThis as unknown as { devicePixelRatio: number }).devicePixelRatio,
    )
    const size = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
    expect(shot.structuredContent).toEqual({
      page: pageId,
      origin: fixtures.httpsOrigin,
      ...size,
    })
    expect(Math.abs(size.width - 120 * scale)).toBeLessThanOrEqual(scale)
    expect(Math.abs(size.height - 40 * scale)).toBeLessThanOrEqual(scale)

    // The whole page, through the DevTools protocol for the one call.
    const full = await allowed(
      'browser_screenshot',
      { fullPage: true },
      `capture the whole page of ${pageId} as an image, secret fields as the page draws them?`,
    )
    expect((full.structuredContent as { width: number }).width).toBeGreaterThan(0)

    // Clicking follows the link; the page's old refs are stale after it.
    const clicked = await allowed(
      'browser_click',
      { element: 'the Next page link', ref: refs.next },
      `click "the Next page link" in ${pageId}?`,
    )
    expect(clicked.structuredContent).toEqual({
      page: pageId,
      origin: fixtures.httpsOrigin,
      ref: refs.next,
    })
    await expect.poll(() => page.url()).toBe(fixtures.secureUrl('mcp-page.html'))
    const stale = await client.callTool({
      name: 'browser_click',
      arguments: { element: 'the Next page link', ref: refs.next },
    })
    expect(stale.isError).toBe(true)
    expect(texts(stale)[0]).toContain('take a new snapshot')
    await expect(prompt).toBeHidden()
  } finally {
    await client.close().catch(() => undefined)
    await nemesis.close()
    await fixtures.close()
  }
})
