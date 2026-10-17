import { expect, test, type Page } from '@playwright/test'
import { launchNemesis } from './_launch'

interface BufferInfo {
  readonly id: string
  readonly kind: string
  readonly title: string
}

interface BufferList {
  readonly buffers: readonly BufferInfo[]
  readonly currentId: string | null
}

interface TestWindow {
  readonly nemesis: {
    readonly buffers: () => Promise<BufferList>
    readonly createBuffer?: (spec: { kind: string; title: string }) => Promise<BufferInfo>
  }
}

/** The buffer list as the main process holds it, current buffer marked (#60). */
async function buffers(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const list = await (globalThis as unknown as TestWindow).nemesis.buffers()
    return list.buffers.map(
      (buffer) => `${buffer.kind} ${buffer.title}${buffer.id === list.currentId ? ' *' : ''}`,
    )
  })
}

test('the window opens a transcript and a prompt buffer, C-x b cycles, C-x k kills', async () => {
  const app = await launchNemesis()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // One window, two visible buffers: the transcript above, the prompt below.
    await expect.poll(() => buffers(page)).toEqual(['transcript Transcript', 'prompt Prompt *'])
    await expect(page.locator('#modeline #buffer-list')).toHaveText('Transcript [Prompt]')
    await expect(page.locator('#prompt')).toHaveAttribute('data-current', 'true')

    // A second transcript buffer, opened through the test-only door.
    await page.evaluate(
      async () =>
        void (await (globalThis as unknown as TestWindow).nemesis.createBuffer?.({
          kind: 'transcript',
          title: 'Transcript 2',
        })),
    )
    await expect
      .poll(() => buffers(page))
      .toEqual(['transcript Transcript', 'prompt Prompt *', 'transcript Transcript 2'])

    // C-x b makes the other buffer current.
    await page.keyboard.press('Control+x')
    await page.keyboard.press('b')
    await expect
      .poll(() => buffers(page))
      .toEqual(['transcript Transcript', 'prompt Prompt', 'transcript Transcript 2 *'])
    await expect(page.locator('#modeline #buffer-list')).toHaveText(
      'Transcript Prompt [Transcript 2]',
    )

    // C-x k kills it, and one transcript buffer remains.
    await page.keyboard.press('Control+x')
    await page.keyboard.press('k')
    await expect.poll(() => buffers(page)).toEqual(['transcript Transcript *', 'prompt Prompt'])
    await expect(page.locator('#transcript')).toHaveAttribute('data-current', 'true')
    await expect(page.locator('#prompt')).not.toHaveAttribute('data-current', 'true')
  } finally {
    await app.close()
  }
})
