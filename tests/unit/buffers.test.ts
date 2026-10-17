import { describe, expect, it } from 'vitest'
import type { BufferList, BufferSpec } from '../../src/shared/buffers'
import {
  BufferError,
  BufferRegistry,
  createCockpitBuffers,
  parseBufferSpec,
} from '../../src/main/buffers'
import { createCockpitRegistry } from '../../src/main/commands/keyscheme'

function titles(buffers: BufferRegistry): string[] {
  return buffers.list().map((buffer) => buffer.title)
}

describe('the buffer registry (#60)', () => {
  it('creates buffers in order and makes the first one current', () => {
    const buffers = new BufferRegistry()
    const first = buffers.create({ kind: 'transcript', title: 'Transcript' })
    const second = buffers.create({ kind: 'prompt', title: 'Prompt', elementId: 'prompt' })
    expect(titles(buffers)).toEqual(['Transcript', 'Prompt'])
    expect(buffers.current?.id).toBe(first.id)
    expect(second.elementId).toBe('prompt')
    expect(first.elementId).toBeNull()
    expect(buffers.get(second.id)).toEqual(second)
  })

  it('refuses a buffer without a usable kind or title', () => {
    const buffers = new BufferRegistry()
    expect(() => buffers.create({ kind: 'transcript', title: '  ' })).toThrow(/needs a title/)
    // No page buffers until M4; the registry says so instead of guessing.
    expect(() => buffers.create({ kind: 'page', title: 'Page' } as unknown as BufferSpec)).toThrow(
      BufferError,
    )
  })

  it('cycles to the next buffer and wraps around, which is what C-x b does', () => {
    const buffers = new BufferRegistry()
    const one = buffers.create({ kind: 'transcript', title: 'One' })
    const two = buffers.create({ kind: 'transcript', title: 'Two' })
    expect(buffers.switchToNext()?.id).toBe(two.id)
    expect(buffers.switchToNext()?.id).toBe(one.id)
    expect(new BufferRegistry().switchToNext()).toBeNull()
  })

  it('switches to a named buffer and complains about an unknown id', () => {
    const buffers = new BufferRegistry()
    buffers.create({ kind: 'transcript', title: 'One' })
    const two = buffers.create({ kind: 'prompt', title: 'Two' })
    expect(buffers.switchTo(two.id).title).toBe('Two')
    expect(() => buffers.switchTo('b99')).toThrow(/No buffer with id/)
  })

  it('kills the current buffer and moves current to the one after it', () => {
    const buffers = new BufferRegistry()
    const one = buffers.create({ kind: 'transcript', title: 'One' })
    const two = buffers.create({ kind: 'transcript', title: 'Two' })
    const three = buffers.create({ kind: 'prompt', title: 'Three' })
    buffers.switchTo(two.id)

    expect(buffers.kill()?.id).toBe(two.id)
    expect(titles(buffers)).toEqual(['One', 'Three'])
    expect(buffers.current?.id).toBe(three.id)

    // Killing the last buffer in the list wraps current back to the first.
    expect(buffers.kill()?.id).toBe(three.id)
    expect(buffers.current?.id).toBe(one.id)
    expect(buffers.kill()?.id).toBe(one.id)
    expect(buffers.current).toBeNull()
    expect(buffers.kill()).toBeNull()
  })

  it('tells its subscribers on every create, switch and kill', () => {
    const buffers = new BufferRegistry()
    const seen: BufferList[] = []
    const unsubscribe = buffers.subscribe((list) => seen.push(list))
    const one = buffers.create({ kind: 'transcript', title: 'One' })
    const two = buffers.create({ kind: 'prompt', title: 'Two' })
    buffers.switchTo(two.id)
    // Switching to the current buffer changes nothing, so it says nothing.
    buffers.switchTo(two.id)
    buffers.kill(one.id)
    unsubscribe()
    buffers.kill(two.id)
    expect(seen.map((list) => list.buffers.length)).toEqual([1, 2, 2, 1])
    expect(seen.at(-1)?.currentId).toBe(two.id)
  })

  it('starts the one M1 window with a transcript above and the prompt below', () => {
    const buffers = createCockpitBuffers()
    expect(buffers.list().map((buffer) => [buffer.kind, buffer.elementId])).toEqual([
      ['transcript', 'transcript'],
      ['prompt', 'prompt'],
    ])
    expect(buffers.current?.kind).toBe('prompt')
  })
})

describe('the buffer commands in the command registry (#59, #60)', () => {
  it('cycles with switch-buffer and kills with kill-buffer', async () => {
    const buffers = createCockpitBuffers()
    const commands = createCockpitRegistry(buffers)
    const context = { source: 'test' } as const

    await commands.run('switch-buffer', context)
    expect(buffers.current?.title).toBe('Transcript')
    await commands.run('kill-buffer', context)
    expect(buffers.list().map((buffer) => buffer.title)).toEqual(['Prompt'])
    expect(buffers.current?.title).toBe('Prompt')
  })
})

describe('what the main process accepts from a page', () => {
  it('validates a buffer spec', () => {
    expect(parseBufferSpec({ kind: 'transcript', title: 'Transcript 2' })).toEqual({
      kind: 'transcript',
      title: 'Transcript 2',
      elementId: null,
    })
    expect(() => parseBufferSpec(null)).toThrow(/not an object/)
    expect(() => parseBufferSpec({ kind: 'page', title: 'Page' })).toThrow(/Unknown buffer kind/)
    expect(() => parseBufferSpec({ kind: 'transcript', title: '' })).toThrow(/usable title/)
    expect(() => parseBufferSpec({ kind: 'transcript', title: 'x', elementId: 7 })).toThrow(
      /usable element id/,
    )
  })

  it('keeps nothing from a buffer in the snapshot but identity', () => {
    const buffers = createCockpitBuffers()
    const snapshot = buffers.snapshot()
    expect(Object.keys(snapshot.buffers[0] ?? {}).sort()).toEqual([
      'elementId',
      'id',
      'kind',
      'title',
    ])
    expect(snapshot.currentId).toBe(buffers.current?.id)
  })
})
