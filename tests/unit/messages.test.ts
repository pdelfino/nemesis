import { describe, expect, it } from 'vitest'
import { MESSAGE_LIMIT, MessageLog, renderMessages } from '../../src/main/messages'

describe('the messages log (#170)', () => {
  it('keeps the last 500 in order', () => {
    const log = new MessageLog()
    for (let index = 0; index < MESSAGE_LIMIT + 20; index++) log.record(`m${index}`)
    const texts = log.list().map((message) => message.text)
    expect(texts).toHaveLength(MESSAGE_LIMIT)
    expect(texts[0]).toBe('m20')
    expect(texts.at(-1)).toBe(`m${MESSAGE_LIMIT + 19}`)
  })

  it('records only notices, with their source, and passes every event on', () => {
    const log = new MessageLog()
    let emit: (event: never) => void = () => {}
    const seen: string[] = []
    log
      .watch({
        on: (listener) => {
          emit = listener as never
          return () => {}
        },
      })
      .on((event) => seen.push(event.type))
    emit({ type: 'notice', text: 'a', source: 'hook' } as never)
    emit({ type: 'notice', text: 'b' } as never)
    emit({ type: 'turn-started' } as never)
    expect(seen).toHaveLength(3)
    expect(log.list().map((m) => [m.source, m.text])).toEqual([
      ['hook', 'a'],
      ['app', 'b'],
    ])
  })

  it('renders a time, a source and the text, newest last', () => {
    const log = new MessageLog()
    log.record('first', 'config', new Date(2026, 9, 20, 9, 5, 7))
    log.record('second', 'download', new Date(2026, 9, 20, 9, 6, 0))
    expect(renderMessages(log.list())).toBe('09:05:07 [config] first\n09:06:00 [download] second')
  })
})
