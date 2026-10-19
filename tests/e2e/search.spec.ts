import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from './_test'
import { launchApp } from './_launch'

/** The candidates the palette lists, highlighted one marked. */
function candidates(page: Page): Promise<string[]> {
  return page
    .locator('#palette-candidates li')
    .evaluateAll((items) =>
      items.map(
        (item) =>
          `${item.firstChild?.textContent ?? ''}${item.getAttribute('aria-selected') === 'true' ? ' *' : ''}`,
      ),
    )
}

/** The transcript's lines, as the DOM shows them. */
function lines(page: Page): Promise<string[]> {
  return page.locator('#transcript .cm-line').allTextContents()
}

interface Fixture {
  readonly id: string
  readonly prompt: string
  readonly reply: readonly string[]
  readonly at: string
  readonly orgDate: string
}

/** Three sessions the recorder could have written (#64): the log and its Org rendering. */
const SESSIONS: readonly Fixture[] = [
  {
    id: 'mock-session',
    prompt: 'plan the garden',
    reply: ['You said: plan the garden', 'Tomatoes need full sun.'],
    at: '2026-10-15T14:00:00.000Z',
    orgDate: '[2026-10-15 Thu 10:00]',
  },
  {
    id: 'mock-session-2',
    prompt: 'fix the login bug',
    reply: ['You said: fix the login bug'],
    at: '2026-10-16T13:00:00.000Z',
    orgDate: '[2026-10-16 Fri 09:00]',
  },
  {
    id: 'mock-session-3',
    prompt: 'shopping list',
    reply: ['You said: shopping list', 'Buy tomato seeds before Sunday.'],
    at: '2026-10-17T12:00:00.000Z',
    orgDate: '[2026-10-17 Sat 08:00]',
  },
]

function writeSession(sessionsDir: string, session: Fixture): void {
  const folder = join(sessionsDir, session.id)
  mkdirSync(folder, { recursive: true })
  const events = [
    { type: 'user-text', text: session.prompt },
    {
      type: 'started',
      sessionId: session.id,
      model: 'claude-mock-1',
      permissionMode: 'default',
      cwd: '/work',
      tools: ['Read'],
    },
    { type: 'assistant-text', text: session.reply.join('\n') },
    {
      type: 'turn-end',
      isError: false,
      result: session.reply.join('\n'),
      durationMs: 1,
      numTurns: 1,
    },
    { type: 'stopped', reason: 'quit' },
  ]
  writeFileSync(
    join(folder, 'events.jsonl'),
    events.map((event) => `${JSON.stringify({ ts: session.at, ...event })}\n`).join(''),
  )
  const org = [
    `#+title: Nemesis session ${session.id}`,
    `#+date: ${session.orgDate}`,
    '',
    `* ${session.orgDate} ${session.prompt}`,
    '** You',
    session.prompt,
    '',
    '- Session started: claude-mock-1, default mode, in /work',
    '',
    '** Claude',
    ...session.reply,
    '',
    '- Session stopped (quit)',
    '',
  ].join('\n')
  const path = join(folder, 'session.org')
  writeFileSync(path, org)
  const modified = new Date(session.at)
  utimesSync(path, modified, modified)
}

// Three sessions on disk, a query that two of them answer (#69): C-x s reads
// the query as free text, the matches are listed newest first with session,
// date and line, and RET on one shows that session with the point on the line.
test('search-transcripts reads a query, lists the matching lines and RET opens the session at the match', async () => {
  const { app, sessionsDir } = await launchApp()
  try {
    for (const session of SESSIONS) writeSession(sessionsDir, session)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('#prompt .cm-content')).toBeFocused()
    const query = page.locator('#palette-input .cm-content')
    const doc = page.locator('#palette-doc')

    // C-x s: the query is free text, so the read lists nothing and says what RET does.
    await page.keyboard.press('Control+x')
    await page.keyboard.press('s')
    await expect(page.locator('#palette-prompt')).toHaveText('Search transcripts:')
    await expect(query).toBeFocused()
    await expect(doc).toHaveText('RET answers with the text typed.')
    expect(await candidates(page)).toEqual([])
    await page.keyboard.type('TOMATO')
    await page.keyboard.press('Enter')

    // The matches: the two sessions that mention tomatoes, newest first, with
    // the first prompt, the date and the line; the login session is not there.
    await expect(page.locator('#palette-prompt')).toHaveText('Open match:')
    await expect
      .poll(() => candidates(page))
      .toEqual([
        'shopping list · 2026-10-17 08:00 · Buy tomato seeds before Sunday. *',
        'plan the garden · 2026-10-15 10:00 · Tomatoes need full sun.',
      ])
    await expect(doc).toHaveText('mock-session-3, line 12')

    // RET on the older match: the garden session is shown again, the
    // transcript takes the point, and the point sits on the matching line.
    await page.keyboard.press('Control+n')
    await expect(doc).toHaveText('mock-session, line 12')
    await page.keyboard.press('Enter')
    await expect
      .poll(() => lines(page))
      .toContain(
        'Resumed session mock-session: 1 earlier turn shown above; the next prompt continues it.',
      )
    await expect(page.locator('#transcript')).toHaveAttribute('data-current', 'true')
    await expect(page.locator('#transcript .cm-content')).toBeFocused()
    await expect(page.locator('#transcript .cm-activeLine')).toHaveText('Tomatoes need full sun.')
    await expect(page.locator('#buffer-list')).toHaveText('[Transcript] Prompt')

    // A query nothing answers lists nothing and says so; C-g leaves.
    await page.keyboard.press('Control+x')
    await page.keyboard.press('s')
    await expect(page.locator('#palette-prompt')).toHaveText('Search transcripts:')
    await page.keyboard.type('zucchini')
    await page.keyboard.press('Enter')
    await expect(page.locator('#palette-prompt')).toHaveText('Nothing matches "zucchini":')
    expect(await candidates(page)).toEqual([])
    await page.keyboard.press('Control+g')
    await expect(page.locator('#palette')).toBeHidden()
  } finally {
    await app.close()
  }
})
