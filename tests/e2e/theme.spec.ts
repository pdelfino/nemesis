import { expect, test, type Page } from '@playwright/test'
import { launchApp } from './_launch'

// The tokens in src/renderer/style.css, as getComputedStyle reports them.
const DARK_BG = 'rgb(30, 30, 30)'
const LIGHT_BG = 'rgb(251, 250, 246)'

/** The slice of the page's window this spec reads; the specs share no DOM lib. */
interface ThemeWindow {
  matchMedia(query: string): { readonly matches: boolean }
  getComputedStyle(element: unknown): { readonly backgroundColor: string }
  readonly document: { readonly body: unknown }
}

function prefersDark(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (globalThis as unknown as ThemeWindow).matchMedia('(prefers-color-scheme: dark)').matches,
  )
}

function bodyBackground(page: Page): Promise<string> {
  return page.evaluate(() => {
    const window = globalThis as unknown as ThemeWindow
    return window.getComputedStyle(window.document.body).backgroundColor
  })
}

/** The prompt editor's class list: CodeMirror puts its light or dark theme class there. */
function promptEditorClasses(page: Page): Promise<string> {
  return page.locator('#prompt .cm-editor').evaluate((editor) => editor.className)
}

test('the appearance is pinned from settings and the editors follow a live change', async () => {
  const { app } = await launchApp('nemesis-theme-', [], { theme: 'dark' })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('#prompt .cm-content')).toBeVisible()

    // The pin reaches the page as prefers-color-scheme (#33).
    expect(await prefersDark(page)).toBe(true)
    expect(await bodyBackground(page)).toBe(DARK_BG)
    const darkClasses = await promptEditorClasses(page)

    // Flip the appearance in the main process, as the OS would: no reload.
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'light'
    })
    await expect.poll(() => prefersDark(page)).toBe(false)
    await expect.poll(() => bodyBackground(page)).toBe(LIGHT_BG)
    await expect.poll(() => promptEditorClasses(page)).not.toBe(darkClasses)
    const lightClasses = await promptEditorClasses(page)

    // And back, so the change is a reconfiguration, not a one-way switch.
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'dark'
    })
    await expect.poll(() => bodyBackground(page)).toBe(DARK_BG)
    await expect.poll(() => promptEditorClasses(page)).toBe(darkClasses)
    expect(lightClasses).not.toBe(darkClasses)
  } finally {
    await app.close()
  }
})
