import { expect, test, type Page } from './_test'
import { launchNemesis } from './_launch'

interface AgentEvent {
  readonly type: string
  readonly text?: string
}

interface DispatchedKey {
  readonly chord: string
  readonly command: string
}

interface TestWindow {
  __agentEvents?: AgentEvent[]
  readonly nemesis: {
    readonly onAgentEvent: (listener: (event: AgentEvent) => void) => void
    readonly promptState: () => Promise<{ draft: string; history: readonly string[] }>
    readonly dispatchLog?: () => Promise<readonly DispatchedKey[]>
  }
}

/** The editor's lines, as the DOM shows them. */
function lines(page: Page): Promise<string[]> {
  return page.locator('#prompt .cm-line').allTextContents()
}

/** Every assistant text the agent sent back, through the public bridge. */
function assistantTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    ((globalThis as unknown as TestWindow).__agentEvents ?? [])
      .filter((event) => event.type === 'assistant-text')
      .map((event) => event.text ?? ''),
  )
}

function promptDraft(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const state = await (globalThis as unknown as TestWindow).nemesis.promptState()
    return state.draft
  })
}

function dispatched(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const log = (await (globalThis as unknown as TestWindow).nemesis.dispatchLog?.()) ?? []
    return log.map((record) => `${record.chord} ${record.command}`)
  })
}

test('the prompt buffer edits like Emacs, sends on C-c C-c, recalls on M-p and keeps its draft', async () => {
  const app = await launchNemesis()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const editor = page.locator('#prompt .cm-content')
    await expect(editor).toBeVisible()
    await expect(editor).toBeFocused()

    // Listen for agent events before anything is sent.
    await page.evaluate(() => {
      const w = globalThis as unknown as TestWindow
      w.__agentEvents = []
      w.nemesis.onAgentEvent((event) => w.__agentEvents?.push(event))
    })

    // Three lines, multi-line by default: Enter is a newline, not a send.
    await page.keyboard.type('one')
    await page.keyboard.press('Enter')
    await page.keyboard.type('two')
    await page.keyboard.press('Enter')
    await page.keyboard.type('three')
    await expect.poll(() => lines(page)).toEqual(['one', 'two', 'three'])

    // C-a to the start of the line, C-k kills the line, then the empty line,
    // C-e to the end of the line, as in Emacs. None of these leave the page.
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Control+k')
    await expect.poll(() => lines(page)).toEqual(['one', '', 'three'])
    await page.keyboard.press('Control+k')
    await expect.poll(() => lines(page)).toEqual(['one', 'three'])
    await page.keyboard.press('Control+e')
    await page.keyboard.type('!')
    await expect.poll(() => lines(page)).toEqual(['one', 'three!'])
    expect(await dispatched(page)).toEqual([])

    // C-c C-c sends; the mock SDK answers with the text it was given.
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+c')
    await expect(page.locator('#prompt-note')).toHaveText('Sent.')
    await expect.poll(() => lines(page)).toEqual([''])
    await expect.poll(() => assistantTexts(page)).toEqual(['You said: one\nthree!'])
    expect(await dispatched(page)).toEqual(['C-c C-c send-prompt'])

    // M-p recalls the prompt just sent, M-n returns to the empty draft.
    await page.keyboard.press('Alt+p')
    await expect.poll(() => lines(page)).toEqual(['one', 'three!'])
    await page.keyboard.press('Alt+n')
    await expect.poll(() => lines(page)).toEqual([''])

    // C-g clears.
    await page.keyboard.type('never mind')
    await expect.poll(() => lines(page)).toEqual(['never mind'])
    await page.keyboard.press('Control+g')
    await expect.poll(() => lines(page)).toEqual([''])

    // The draft is parked in the main process and survives a reload.
    await page.keyboard.type('kept across a reload')
    await expect.poll(() => promptDraft(page)).toBe('kept across a reload')
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await expect.poll(() => lines(page)).toEqual(['kept across a reload'])
    // History came back too.
    await page.locator('#prompt .cm-content').click()
    await page.keyboard.press('Alt+p')
    await expect.poll(() => lines(page)).toEqual(['one', 'three!'])
  } finally {
    await app.close()
  }
})
