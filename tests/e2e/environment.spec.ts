import { cpSync, mkdirSync, mkdtempSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from './_test'
import { launchApp } from './_launch'

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'environment')

/** The environment buffer's lines, as the editor shows them. */
function panelLines(page: Page): Promise<string[]> {
  return page.locator('#environment .cm-line').allTextContents()
}

/** The transcript's lines, as the DOM shows them. */
function transcriptLines(page: Page): Promise<string[]> {
  return page.locator('#transcript .cm-line').allTextContents()
}

/** Runs a command by name through M-x. */
async function runCommand(page: Page, name: string): Promise<void> {
  await page.keyboard.press('Alt+x')
  await expect(page.locator('#palette-input .cm-content')).toBeFocused()
  await page.keyboard.type(name)
  await expect
    .poll(() =>
      page
        .locator('#palette-candidates li[aria-selected="true"]')
        .evaluate((item) => item.firstChild?.textContent ?? ''),
    )
    .toBe(name)
  await page.keyboard.press('Enter')
}

/** A size as the panel prints it, for the lines the spec expects. */
function size(path: string): string {
  const bytes = statSync(path).size
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

// The guide's "configure your environment" as one buffer (#86): C-c C-e lists
// every CLAUDE.md that applies with a warning past the length threshold, the
// permission rules and hooks of the settings files as text, the skills and
// subagents on disk, the server names in .mcp.json, and, once a session has
// started, what the SDK's init frame reports. RET opens a listed file through
// the open door, after a yes; edit-claude-md takes the nearest CLAUDE.md the
// same way with the guide's reminder; doctor lists the long files.
test('C-c C-e shows the environment of the working directory; RET, edit-claude-md and doctor act on it', async () => {
  // The fixture is copied out of the repository: the copy's own .git stops
  // the walk up before this repository's CLAUDE.md, and the copied home
  // keeps the developer's own ~/.claude out of the panel.
  const tree = realpathSync.native(mkdtempSync(join(tmpdir(), 'nemesis-environment-')))
  const project = join(tree, 'project')
  const home = join(tree, 'home')
  cpSync(join(FIXTURE, 'project'), project, { recursive: true })
  cpSync(join(FIXTURE, 'home'), home, { recursive: true })
  mkdirSync(join(project, '.git'))

  const { app } = await launchApp('nemesis-e2e-', [], {}, { NEMESIS_HOME: home }, project)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const prompt = page.locator('#prompt .cm-content')
    const modeline = page.locator('#buffer-list')
    const panel = page.locator('#environment')
    const transcript = page.locator('#transcript .cm-content')
    await expect(prompt).toBeFocused()

    // Before any session: the files are read off disk, the session part says so.
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+e')
    await expect(panel).toBeVisible()
    await expect(modeline).toHaveText('Transcript Prompt [Environment]')
    await expect(page.locator('#environment .cm-content')).toBeFocused()
    await expect(page.locator('#environment-keys')).toHaveText(
      'RET opens a listed file with the default application, after a yes',
    )
    let lines = await panelLines(page)
    expect(lines[0]).toBe(`Environment of ${project}`)
    expect(lines[1]).toBe(`Git root: ${project}`)
    // The two CLAUDE.md files of the project and the user's, each with its
    // count and size; the long one carries the warning on the line below.
    expect(lines).toContain('CLAUDE.md files (3)')
    expect(lines).toContain(
      `  ~/.claude/CLAUDE.md: 3 lines, ${size(join(home, '.claude', 'CLAUDE.md'))}`,
    )
    const long = lines.indexOf(`  CLAUDE.md: 205 lines, ${size(join(project, 'CLAUDE.md'))}`)
    expect(long).toBeGreaterThan(0)
    expect(lines[long + 1]).toBe(
      "    Warning: over 200 lines. The guide's test for every line: would removing this line cause mistakes?",
    )
    expect(lines).toContain(
      `  .claude/CLAUDE.md: 3 lines, ${size(join(project, '.claude', 'CLAUDE.md'))}`,
    )
    // The rules as text, per file; the one hook by event, matcher and command.
    expect(lines).toContain('    allow: Read, Bash(git status *)')
    expect(lines).toContain('    allow: Bash(npm run *)')
    expect(lines).toContain('    deny: Bash(rm -rf *)')
    expect(lines).toContain('  .claude/settings.local.json: no file')
    expect(lines).toContain('    PreToolUse (Bash): npm run lint')
    expect(lines.filter((line) => line.includes('PreToolUse'))).toHaveLength(1)
    // Skills, servers and subagents on disk; the session's lists are not here yet.
    expect(lines).toContain(
      '  On disk: deploy (.claude/skills/deploy/SKILL.md), review (~/.claude/skills/review/SKILL.md)',
    )
    expect(lines).toContain('  .mcp.json: docs, github')
    expect(lines).toContain(
      '  On disk: tester (.claude/agents/tester.md), reviewer (~/.claude/agents/reviewer.md)',
    )
    expect(lines.filter((line) => line === '  From the session: (no session yet)')).toHaveLength(3)
    expect(lines).toContain("  No session yet: the SDK's lists arrive with the first prompt.")
    // Nothing of the .mcp.json env block reached the window.
    expect(lines.join('\n')).not.toContain('FIXTURE-NOT-A-REAL-TOKEN')

    // A session started: C-c C-e again reuses the buffer and shows the
    // mock's init frame, its two servers with their status first.
    // C-x b cycles in creation order: the transcript first, then the prompt.
    await page.keyboard.press('Control+x')
    await page.keyboard.press('b')
    await expect(modeline).toHaveText('[Transcript] Prompt Environment')
    await page.keyboard.press('Control+x')
    await page.keyboard.press('b')
    await expect(prompt).toBeFocused()
    await page.keyboard.type('hello')
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+c')
    await expect(transcript).toContainText('You said: hello')
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+e')
    await expect(modeline).toHaveText('Transcript Prompt [Environment]')
    await expect
      .poll(() => panelLines(page))
      .toContain('  From the session: mock-docs (connected), mock-broken (failed)')
    lines = await panelLines(page)
    expect(lines).toContain('  From the session: mock-skill')
    expect(lines).toContain('  From the session: mock-reviewer')
    expect(lines).toContain('  Model: claude-mock-1')
    expect(lines).toContain('  Claude Code: mock')
    expect(lines).toContain('  Plugins: (none)')
    expect(lines).toContain('  Slash commands: compact')

    // RET: the listed files on the palette, in the panel's order; the pick
    // asks in the prompt buffer, and the no that comes first launches nothing.
    await page.keyboard.press('Enter')
    await expect(page.locator('#palette-prompt')).toHaveText('Open file:')
    await expect(page.locator('#palette-candidates li').first()).toContainText(
      '~/.claude/CLAUDE.md',
    )
    await page.keyboard.type('.claude/settings.json')
    await expect
      .poll(() =>
        page
          .locator('#palette-candidates li[aria-selected="true"]')
          .evaluate((item) => item.firstChild?.textContent ?? ''),
      )
      .toBe('.claude/settings.json')
    await page.keyboard.press('Enter')
    const settings = join(project, '.claude', 'settings.json')
    await expect(page.locator('#palette-prompt')).toHaveText(
      `Open ${settings} with the default application?`,
    )
    await expect(page.locator('#palette-candidates li[aria-selected="true"]')).toContainText(
      'Do not open',
    )
    await page.keyboard.press('Enter')
    await expect
      .poll(() => transcriptLines(page))
      .toContain(`Not opened: ${settings}; nothing was launched (SECURITY.org, promise 2)`)
    await expect(page.locator('#palette')).toBeHidden()

    // edit-claude-md: the reminder is a notice first, then the nearest
    // CLAUDE.md, the project's, asks the same question; C-g is a no.
    await runCommand(page, 'edit-claude-md')
    const claudeMd = join(project, 'CLAUDE.md')
    await expect(page.locator('#palette-prompt')).toHaveText(
      `Open ${claudeMd} with the default application?`,
    )
    await expect
      .poll(() => transcriptLines(page))
      .toContain(
        `CLAUDE.md at ${claudeMd}. A bloated CLAUDE.md gets ignored. For every line ask: would removing this line cause mistakes? If not, cut it.`,
      )
    await page.keyboard.press('Control+g')
    await expect
      .poll(() => transcriptLines(page))
      .toContain(`Not opened: ${claudeMd}; nothing was launched (SECURITY.org, promise 2)`)

    // doctor: the long file, with the reason, in the help buffer.
    await runCommand(page, 'doctor')
    await expect(page.locator('#help')).toBeVisible()
    await expect(modeline).toHaveText('Transcript Prompt Environment [Help]')
    const help = await page.locator('#help .cm-line').allTextContents()
    expect(help[0]).toBe(
      'Doctor: 1 of 3 CLAUDE.md files over the threshold (200 lines or 12.0 KB):',
    )
    expect(help[1]).toBe(`  CLAUDE.md: 205 lines, ${size(claudeMd)} (over 200 lines)`)

    // C-x k kills the environment buffer like any other; its section goes
    // with it. Killing the last buffer wraps the point to the transcript, so
    // two C-x b bring it to the environment buffer first.
    await page.keyboard.press('Control+x')
    await page.keyboard.press('k')
    await expect(page.locator('#help')).toBeHidden()
    await expect(modeline).toHaveText('[Transcript] Prompt Environment')
    await page.keyboard.press('Control+x')
    await page.keyboard.press('b')
    await page.keyboard.press('Control+x')
    await page.keyboard.press('b')
    await expect(modeline).toHaveText('Transcript Prompt [Environment]')
    await page.keyboard.press('Control+x')
    await page.keyboard.press('k')
    await expect(panel).toBeHidden()
    await expect(modeline).toHaveText('[Transcript] Prompt')
  } finally {
    await app.close()
  }
})
