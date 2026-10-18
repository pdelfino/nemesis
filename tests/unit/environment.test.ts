import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentStartedEvent } from '../../src/main/agent/events'
import { createCockpitBuffers } from '../../src/main/buffers'
import {
  CLAUDE_MD_MAX_BYTES,
  CLAUDE_MD_MAX_LINES,
  CLAUDE_MD_REMINDER,
  collectEnvironment,
  collectInstructions,
  EnvironmentBuffers,
  findGitRoot,
  formatBytes,
  instructionDirs,
  listedFiles,
  nearestClaudeMd,
  renderDoctor,
  renderEnvironment,
  shortPath,
} from '../../src/main/environment'

// The environment panel (#86): the collectors over the fixture tree, the
// rendering, and the buffer with its one door.

const FIXTURE = realpathSync.native(join(import.meta.dirname, '../fixtures/environment'))
const PROJECT = join(FIXTURE, 'project')
const HOME = join(FIXTURE, 'home')

const started: AgentStartedEvent = {
  type: 'started',
  sessionId: 's1',
  model: 'claude-mock-1',
  permissionMode: 'default',
  cwd: PROJECT,
  tools: ['Read'],
  claudeCodeVersion: '2.1.0',
  mcpServers: [
    { name: 'mock-docs', status: 'connected' },
    { name: 'mock-broken', status: 'failed' },
  ],
  skills: ['mock-skill'],
  agents: ['mock-reviewer'],
  slashCommands: ['compact'],
  plugins: [{ name: 'notes', version: '0.2.0' }, { name: 'bare' }],
}

function collect(cwd = PROJECT, init: AgentStartedEvent | null = started) {
  return collectEnvironment({ cwd, home: HOME, root: PROJECT, started: init })
}

describe('the instruction folders', () => {
  it('run from the git root down to the working directory', () => {
    expect(instructionDirs(join(PROJECT, 'sub'), PROJECT)).toEqual([PROJECT, join(PROJECT, 'sub')])
    expect(instructionDirs(PROJECT, PROJECT)).toEqual([PROJECT])
  })

  it('are the working directory alone without a root, or with a root it is not under', () => {
    expect(instructionDirs(PROJECT, null)).toEqual([PROJECT])
    expect(instructionDirs(PROJECT, HOME)).toEqual([PROJECT])
  })

  it('find the git root by a .git entry, folder or file, and none above a tree without one', () => {
    const tree = mkdtempSync(join(tmpdir(), 'nemesis-environment-'))
    mkdirSync(join(tree, 'repo', 'deep', 'er'), { recursive: true })
    mkdirSync(join(tree, 'repo', '.git'))
    expect(findGitRoot(join(tree, 'repo', 'deep', 'er'))).toBe(join(tree, 'repo'))
    mkdirSync(join(tree, 'worktree', 'src'), { recursive: true })
    writeFileSync(join(tree, 'worktree', '.git'), 'gitdir: elsewhere\n')
    expect(findGitRoot(join(tree, 'worktree', 'src'))).toBe(join(tree, 'worktree'))
    // The fixture tree lives inside this repository, whose root is above it;
    // a folder with no .git anywhere up to / answers null.
    expect(findGitRoot('/')).toBeNull()
  })
})

describe('the CLAUDE.md files', () => {
  it("are the user's, then every CLAUDE.md, CLAUDE.local.md and .claude/CLAUDE.md from the root down", () => {
    const files = collectInstructions(join(PROJECT, 'sub'), HOME, PROJECT)
    expect(files.map((file) => file.path)).toEqual([
      join(HOME, '.claude', 'CLAUDE.md'),
      join(PROJECT, 'CLAUDE.md'),
      join(PROJECT, '.claude', 'CLAUDE.md'),
      join(PROJECT, 'sub', 'CLAUDE.local.md'),
    ])
  })

  it('carry their line count and size, and are long past 200 lines or 12 KB', () => {
    const files = collectInstructions(PROJECT, HOME, PROJECT)
    const user = files[0]
    const long = files[1]
    expect(user).toMatchObject({ lines: 3, long: false })
    expect(user?.bytes).toBeGreaterThan(0)
    expect(long).toMatchObject({ lines: 205, long: true })
    expect(long?.bytes).toBeLessThan(CLAUDE_MD_MAX_BYTES)
    expect(long?.lines).toBeGreaterThan(CLAUDE_MD_MAX_LINES)
  })

  it('warn in the panel with the guide’s test, once per long file, on the line below it', () => {
    const text = renderEnvironment(collect())
    const lines = text.split('\n')
    const at = lines.findIndex((line) => line.startsWith('  CLAUDE.md: 205 lines, '))
    expect(at).toBeGreaterThan(0)
    expect(lines[at + 1]).toBe(
      "    Warning: over 200 lines. The guide's test for every line: would removing this line cause mistakes?",
    )
    expect(lines.filter((line) => line.includes('Warning:'))).toHaveLength(1)
    expect(text).toContain('CLAUDE.md files (3)')
    expect(text).toContain('  ~/.claude/CLAUDE.md: 3 lines, ')
    expect(text).toContain('  .claude/CLAUDE.md: 3 lines, ')
  })

  it('name the nearest one: the working directory first, then its parents, then the user’s', () => {
    expect(nearestClaudeMd(collect(join(PROJECT, 'sub')))).toBe(
      join(PROJECT, 'sub', 'CLAUDE.local.md'),
    )
    expect(nearestClaudeMd(collect(PROJECT))).toBe(join(PROJECT, 'CLAUDE.md'))
    const elsewhere = mkdtempSync(join(tmpdir(), 'nemesis-environment-'))
    expect(
      nearestClaudeMd(
        collectEnvironment({ cwd: elsewhere, home: HOME, root: null, started: null }),
      ),
    ).toBe(join(HOME, '.claude', 'CLAUDE.md'))
    const noHome = mkdtempSync(join(tmpdir(), 'nemesis-environment-'))
    expect(
      nearestClaudeMd(
        collectEnvironment({ cwd: elsewhere, home: noHome, root: null, started: null }),
      ),
    ).toBeNull()
  })
})

describe('the settings files', () => {
  it('give their permission rules as text, per file, in layer order', () => {
    const report = collect()
    expect(report.permissions).toEqual([
      {
        path: join(HOME, '.claude', 'settings.json'),
        allow: ['Read', 'Bash(git status *)'],
        deny: [],
        ask: [],
      },
      {
        path: join(PROJECT, '.claude', 'settings.json'),
        allow: ['Bash(npm run *)'],
        deny: ['Bash(rm -rf *)'],
        ask: [],
      },
    ])
    expect(report.settings.map((file) => [shortPath(report, file.path), file.exists])).toEqual([
      ['~/.claude/settings.json', true],
      ['.claude/settings.json', true],
      ['.claude/settings.local.json', false],
    ])
    const text = renderEnvironment(report)
    expect(text).toContain('Permission rules (shown as text; the panel grants and edits nothing)')
    expect(text).toContain(
      '  ~/.claude/settings.json\n    allow: Read, Bash(git status *)\n    deny: (none)\n    ask: (none)',
    )
    expect(text).toContain(
      '  .claude/settings.json\n    allow: Bash(npm run *)\n    deny: Bash(rm -rf *)\n    ask: (none)',
    )
    expect(text).toContain('  .claude/settings.local.json: no file')
  })

  it('give their hooks by event, matcher and command', () => {
    const report = collect()
    expect(report.hooks).toEqual([
      { path: join(HOME, '.claude', 'settings.json'), hooks: [] },
      {
        path: join(PROJECT, '.claude', 'settings.json'),
        hooks: [{ event: 'PreToolUse', matcher: 'Bash', command: 'npm run lint' }],
      },
    ])
    const text = renderEnvironment(report)
    expect(text).toContain(
      'Hooks\n  ~/.claude/settings.json: no hooks\n  .claude/settings.json\n    PreToolUse (Bash): npm run lint',
    )
  })

  it('cut a long hook command, and name a hook without a command by its type', () => {
    const tree = mkdtempSync(join(tmpdir(), 'nemesis-environment-'))
    mkdirSync(join(tree, '.claude'))
    const command = `echo ${'x'.repeat(100)}`
    writeFileSync(
      join(tree, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command },
                { type: 'prompt', prompt: 'Check' },
              ],
            },
          ],
        },
      }),
    )
    const report = collectEnvironment({
      cwd: tree,
      home: join(tree, 'nohome'),
      root: null,
      started: null,
    })
    expect(report.hooks).toEqual([
      {
        path: join(tree, '.claude', 'settings.json'),
        hooks: [
          { event: 'Stop', matcher: null, command: `${command.slice(0, 72)}...` },
          { event: 'Stop', matcher: null, command: '(prompt hook)' },
        ],
      },
    ])
  })

  it('report a file that is not valid JSON as such, without quoting it', () => {
    const tree = mkdtempSync(join(tmpdir(), 'nemesis-environment-'))
    mkdirSync(join(tree, '.claude'))
    writeFileSync(join(tree, '.claude', 'settings.json'), '{ "permissions": { SECRET-LOOKING }')
    const report = collectEnvironment({
      cwd: tree,
      home: join(tree, 'nohome'),
      root: null,
      started: null,
    })
    expect(report.settings[1]).toEqual({
      path: join(tree, '.claude', 'settings.json'),
      exists: true,
      unreadable: true,
    })
    expect(report.permissions).toEqual([])
    const text = renderEnvironment(report)
    expect(text).toContain('  .claude/settings.json: not valid JSON')
    expect(text).not.toContain('SECRET-LOOKING')
  })
})

describe('skills, servers and subagents', () => {
  it('are the SKILL.md folders and the agent files of the project and the home, by name', () => {
    const report = collect()
    expect(report.skills).toEqual([
      { name: 'deploy', path: join(PROJECT, '.claude', 'skills', 'deploy', 'SKILL.md') },
      { name: 'review', path: join(HOME, '.claude', 'skills', 'review', 'SKILL.md') },
    ])
    expect(report.agents).toEqual([
      { name: 'tester', path: join(PROJECT, '.claude', 'agents', 'tester.md') },
      { name: 'reviewer', path: join(HOME, '.claude', 'agents', 'reviewer.md') },
    ])
    const text = renderEnvironment(report)
    expect(text).toContain(
      'Skills\n  On disk: deploy (.claude/skills/deploy/SKILL.md), review (~/.claude/skills/review/SKILL.md)\n  From the session: mock-skill',
    )
    expect(text).toContain(
      'Subagents\n  On disk: tester (.claude/agents/tester.md), reviewer (~/.claude/agents/reviewer.md)\n  From the session: mock-reviewer',
    )
  })

  it('list the names in .mcp.json and nothing of its env blocks, next to the init frame’s servers', () => {
    const report = collect()
    expect(report.mcpFile).toEqual({ path: join(PROJECT, '.mcp.json'), names: ['docs', 'github'] })
    const text = renderEnvironment(report)
    expect(text).toContain(
      'MCP servers\n  From the session: mock-docs (connected), mock-broken (failed)\n  .mcp.json: docs, github',
    )
    expect(text).not.toContain('FIXTURE-NOT-A-REAL-TOKEN')
    expect(text).not.toContain('DOCS_TOKEN')
    expect(text).not.toContain('example.invalid')
  })

  it('show the model, the Claude Code version, the plugins and the slash commands of the session', () => {
    expect(renderEnvironment(collect())).toContain(
      'Session\n  Model: claude-mock-1\n  Claude Code: 2.1.0\n  Plugins: notes 0.2.0, bare\n  Slash commands: compact',
    )
  })

  it('say there is no session yet before the first prompt', () => {
    const text = renderEnvironment(collect(PROJECT, null))
    expect(text).toContain('  From the session: (no session yet)')
    expect(text).toContain(
      "Session\n  No session yet: the SDK's lists arrive with the first prompt.",
    )
    expect(text).toContain('  .mcp.json: docs, github')
  })
})

describe('the panel text', () => {
  it('opens with the working directory and the git root, and closes with the one key', () => {
    const text = renderEnvironment(collect())
    expect(text.startsWith(`Environment of ${PROJECT}\nGit root: ${PROJECT}\n`)).toBe(true)
    expect(
      text.endsWith('RET opens a listed file with the default application, after a yes.'),
    ).toBe(true)
    expect(
      renderEnvironment(
        collectEnvironment({ cwd: PROJECT, home: HOME, root: null, started: null }),
      ),
    ).toContain('Git root: none')
  })

  it('prints sizes in bytes under a kilobyte and in kilobytes above, and paths short', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(12 * 1024)).toBe('12.0 KB')
    expect(formatBytes(13866)).toBe('13.5 KB')
    const report = collect()
    expect(shortPath(report, join(PROJECT, 'CLAUDE.md'))).toBe('CLAUDE.md')
    expect(shortPath(report, join(HOME, '.claude', 'CLAUDE.md'))).toBe('~/.claude/CLAUDE.md')
    expect(shortPath(report, '/elsewhere/CLAUDE.md')).toBe('/elsewhere/CLAUDE.md')
  })

  it('lists every file it shows, each once, in panel order: the allowlist for RET', () => {
    expect(listedFiles(collect())).toEqual([
      join(HOME, '.claude', 'CLAUDE.md'),
      join(PROJECT, 'CLAUDE.md'),
      join(PROJECT, '.claude', 'CLAUDE.md'),
      join(HOME, '.claude', 'settings.json'),
      join(PROJECT, '.claude', 'settings.json'),
      join(PROJECT, '.claude', 'skills', 'deploy', 'SKILL.md'),
      join(HOME, '.claude', 'skills', 'review', 'SKILL.md'),
      join(PROJECT, '.mcp.json'),
      join(PROJECT, '.claude', 'agents', 'tester.md'),
      join(HOME, '.claude', 'agents', 'reviewer.md'),
    ])
  })
})

describe('doctor', () => {
  it('lists the CLAUDE.md files over the threshold with the reason', () => {
    expect(renderDoctor(collect())).toBe(
      [
        'Doctor: 1 of 3 CLAUDE.md files over the threshold (200 lines or 12.0 KB):',
        `  CLAUDE.md: 205 lines, ${formatBytes(collect().instructions[1]?.bytes ?? 0)} (over 200 lines)`,
        '',
        "The guide's test for every line: would removing this line cause mistakes?",
      ].join('\n'),
    )
  })

  it('says all are within it, or that none applies', () => {
    expect(renderDoctor(collect(join(PROJECT, 'sub')))).toContain('1 of 4 CLAUDE.md files over')
    const tree = mkdtempSync(join(tmpdir(), 'nemesis-environment-'))
    expect(
      renderDoctor(collectEnvironment({ cwd: tree, home: HOME, root: null, started: null })),
    ).toBe('Doctor: all 1 CLAUDE.md file within 200 lines and 12.0 KB.')
    expect(
      renderDoctor(
        collectEnvironment({ cwd: tree, home: join(tree, 'nohome'), root: null, started: null }),
      ),
    ).toBe(`Doctor: no CLAUDE.md applies to ${tree}.`)
  })
})

interface Harness {
  readonly environment: EnvironmentBuffers
  readonly notices: string[]
  readonly shown: { bufferId: string; text: string }[]
  readonly answers: boolean[]
  readonly questions: string[]
  readonly opened: string[]
  readonly buffers: ReturnType<typeof createCockpitBuffers>
}

function harness(cwd = PROJECT, init: AgentStartedEvent | null = started): Harness {
  const buffers = createCockpitBuffers()
  const answers: boolean[] = []
  const questions: string[] = []
  const opened: string[] = []
  const environment = new EnvironmentBuffers(buffers, {
    cwd,
    home: HOME,
    started: () => init,
    findRoot: () => PROJECT,
    confirm: (question) => {
      questions.push(question)
      return Promise.resolve(answers.shift() ?? false)
    },
    open: (path) => {
      opened.push(path)
      return Promise.resolve('')
    },
  })
  const notices: string[] = []
  environment.on((event) => notices.push(event.text))
  const shown: Harness['shown'] = []
  environment.onShown((content) => shown.push(content))
  return { environment, notices, shown, answers, questions, opened, buffers }
}

describe('the environment buffer', () => {
  it('shows the panel in one buffer, reused by the next call, with the point', () => {
    const h = harness()
    const first = h.environment.show()
    expect(first).toMatchObject({
      kind: 'environment',
      title: 'Environment',
      elementId: 'environment',
    })
    expect(h.buffers.current?.id).toBe(first.id)
    expect(h.shown).toHaveLength(1)
    expect(h.shown[0]?.text).toContain('CLAUDE.md files (3)')
    const second = h.environment.show()
    expect(second.id).toBe(first.id)
    expect(h.buffers.list().filter((buffer) => buffer.kind === 'environment')).toHaveLength(1)
    // Killed, it comes back on the next call as a new buffer.
    h.buffers.kill(first.id)
    expect(h.environment.buffer).toBeNull()
    expect(h.environment.show().id).not.toBe(first.id)
  })

  it('opens a listed file only after a yes, and says what happened in a notice', async () => {
    const h = harness()
    const path = join(PROJECT, '.claude', 'settings.json')
    expect(h.environment.files()).toContain(path)
    expect(h.environment.label(path)).toBe('.claude/settings.json')
    h.answers.push(false)
    expect(await h.environment.open(path)).toBe(false)
    expect(h.questions).toEqual([`Open ${path} with the default application?`])
    expect(h.opened).toEqual([])
    expect(h.notices).toEqual([
      `Not opened: ${path}; nothing was launched (SECURITY.org, promise 2)`,
    ])
    h.answers.push(true)
    expect(await h.environment.open(path)).toBe(true)
    expect(h.opened).toEqual([path])
    expect(h.notices.at(-1)).toBe(`Opened ${path} with the default application`)
  })

  it('refuses a path the panel does not list without asking', async () => {
    const h = harness()
    const outside = join(PROJECT, 'sub', 'CLAUDE.local.md')
    expect(await h.environment.open(outside)).toBe(false)
    expect(await h.environment.open('/etc/passwd')).toBe(false)
    expect(h.questions).toEqual([])
    expect(h.opened).toEqual([])
    expect(h.notices).toEqual([
      `Not opened: ${outside} is not a file the environment panel lists`,
      'Not opened: /etc/passwd is not a file the environment panel lists',
    ])
  })

  it("edit-claude-md shows the guide's reminder, then takes the nearest CLAUDE.md through the door", async () => {
    const h = harness()
    h.answers.push(true)
    expect(await h.environment.editClaudeMd()).toBe(true)
    const path = join(PROJECT, 'CLAUDE.md')
    expect(h.notices[0]).toBe(`CLAUDE.md at ${path}. ${CLAUDE_MD_REMINDER}`)
    expect(h.questions).toEqual([`Open ${path} with the default application?`])
    expect(h.opened).toEqual([path])
  })

  it('edit-claude-md with no CLAUDE.md anywhere says so and opens nothing', async () => {
    const tree = mkdtempSync(join(tmpdir(), 'nemesis-environment-'))
    const buffers = createCockpitBuffers()
    const notices: string[] = []
    const environment = new EnvironmentBuffers(buffers, {
      cwd: tree,
      home: join(tree, 'nohome'),
      started: () => null,
      confirm: () => Promise.reject(new Error('should not ask')),
      open: () => Promise.reject(new Error('should not open')),
    })
    environment.on((event) => notices.push(event.text))
    expect(await environment.editClaudeMd()).toBe(false)
    expect(notices).toEqual([
      `No CLAUDE.md applies to ${tree}: create one there, or in ~/.claude, and keep it short. ${CLAUDE_MD_REMINDER}`,
    ])
  })

  it('doctor answers from a fresh read', () => {
    expect(harness().environment.doctor()).toContain('1 of 3 CLAUDE.md files over the threshold')
  })
})
