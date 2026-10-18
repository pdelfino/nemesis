import { describe, expect, it, vi } from 'vitest'
import { fuzzyScore, rankCandidates } from '../../src/shared/palette'
import { parsePaletteAnswer, Prompter } from '../../src/main/commands/prompter'
import { createCockpitRegistry, resolveCockpitDeps } from '../../src/main/commands/keyscheme'

const candidates = [
  { id: 'search-buffer', label: 'search-buffer', doc: 'Search.' },
  { id: 'switch-buffer', label: 'switch-buffer', doc: 'Switch.' },
  { id: 'describe-key', label: 'describe-key', doc: 'Key.' },
  { id: 'describe-command', label: 'describe-command', doc: 'Command.' },
  { id: 'kill-buffer', label: 'kill-buffer', doc: 'Kill.' },
  { id: 'keyboard-quit', label: 'keyboard-quit', doc: 'Quit.' },
]

describe('fuzzy ranking (#65)', () => {
  it('matches the query as a subsequence, case folded, and nothing else', () => {
    expect(fuzzyScore('sb', 'switch-buffer')).not.toBeNull()
    expect(fuzzyScore('SB', 'switch-buffer')).not.toBeNull()
    expect(fuzzyScore('bs', 'switch-buffer')).toBeNull()
    expect(fuzzyScore('', 'anything')).toBe(0)
  })

  it('ranks a prefix and word starts first, ties alphabetically', () => {
    expect(rankCandidates('desc', candidates).map((c) => c.id)).toEqual([
      'describe-command',
      'describe-key',
    ])
    // k then b: kill-buffer starts both words, keyboard-quit does not.
    expect(rankCandidates('kb', candidates).map((c) => c.id)).toEqual([
      'kill-buffer',
      'keyboard-quit',
    ])
    expect(rankCandidates('xyz', candidates)).toEqual([])
    // An empty query keeps the source's order.
    expect(rankCandidates('', candidates)).toEqual(candidates)
  })
})

describe('the prompter', () => {
  function prompter() {
    const instance = new Prompter()
    instance.addSource({ name: 'letters', candidates: () => candidates.slice(0, 2) })
    return instance
  }

  it('pushes a read with the source candidates and hands the choice to the consumer', async () => {
    const instance = prompter()
    const seen = vi.fn()
    instance.on(seen)
    const consume = vi.fn(() => ({ command: 'search-buffer' }))
    const request = instance.read({ source: 'letters', prompt: 'M-x' }, consume)
    expect(seen).toHaveBeenCalledWith(request)
    expect(request).toMatchObject({ prompt: 'M-x', source: 'letters' })
    expect(request.candidates.map((c) => c.id)).toEqual(['search-buffer', 'switch-buffer'])
    expect(instance.pending).toBe(request)

    expect(await instance.answer({ id: request.id, choice: 'search-buffer' })).toEqual({
      command: 'search-buffer',
    })
    expect(consume).toHaveBeenCalledWith('search-buffer')
    expect(instance.pending).toBeNull()
  })

  it('cancels on null, ignores a stale answer and refuses a stranger', async () => {
    const instance = prompter()
    const first = vi.fn()
    const stale = instance.read({ source: 'letters', prompt: 'A' }, first)
    const second = vi.fn()
    const live = instance.read({ source: 'letters', prompt: 'B' }, second)
    // The newer read replaced the older one; the window's answer to it is dropped.
    expect(await instance.answer({ id: stale.id, choice: 'search-buffer' })).toEqual({})
    expect(first).not.toHaveBeenCalled()
    await expect(instance.answer({ id: live.id, choice: 'nope' })).rejects.toThrow(
      /not among the candidates/,
    )
    expect(await instance.answer({ id: live.id, choice: null })).toEqual({})
    expect(second).not.toHaveBeenCalled()
    expect(instance.pending).toBeNull()
  })

  it('knows its sources by name, once each', () => {
    const instance = prompter()
    expect(() => instance.read({ source: 'ghosts', prompt: '?' }, () => undefined)).toThrow(
      /No palette source/,
    )
    expect(() => instance.addSource({ name: 'letters', candidates: () => [] })).toThrow(
      /already registered/,
    )
  })

  it('offers the cockpit commands with their keys, and the buffers', () => {
    const deps = resolveCockpitDeps()
    createCockpitRegistry(deps)
    const commands = deps.prompter.read({ source: 'commands', prompt: 'M-x' }, () => undefined)
    expect(commands.candidates.find((c) => c.id === 'switch-buffer')).toEqual({
      id: 'switch-buffer',
      label: 'switch-buffer',
      doc: 'Switch to the next buffer.',
      detail: 'C-x b',
    })
    expect(commands.candidates.find((c) => c.id === 'answer-yes')?.detail).toBe('y (permission)')
    expect(commands.candidates.find((c) => c.id === 'choose-buffer')?.detail).toBe('')
    const buffers = deps.prompter.read({ source: 'buffers', prompt: 'Buffer:' }, () => undefined)
    expect(buffers.candidates).toEqual([
      { id: 'b1', label: 'Transcript', doc: 'transcript buffer' },
      { id: 'b2', label: 'Prompt', doc: 'prompt buffer, current' },
    ])
  })

  it('validates the answer payload from a page', () => {
    expect(parsePaletteAnswer({ id: 'p1', choice: 'x' })).toEqual({ id: 'p1', choice: 'x' })
    expect(parsePaletteAnswer({ id: 'p1' })).toEqual({ id: 'p1', choice: null })
    expect(() => parsePaletteAnswer(null)).toThrow(/not an object/)
    expect(() => parsePaletteAnswer({ choice: 'x' })).toThrow(/usable id/)
    expect(() => parsePaletteAnswer({ id: 'p1', choice: 3 })).toThrow(/usable choice/)
    expect(() => parsePaletteAnswer({ id: 'p1', choice: 'x'.repeat(201) })).toThrow(/usable choice/)
  })
})
