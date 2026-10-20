import { describe, expect, it } from 'vitest'
import { FAN_OUT_USAGE, fanOutPrompt, parseFanOut, runLabel } from '../../src/main/fan-out'

// fan-out (#160): the draft as a plan, each session's first prompt, the run's label.

describe('parseFanOut', () => {
  it('reads the first non-empty line as the instruction and every other non-empty line as an item', () => {
    expect(
      parseFanOut('\n  Fix the failing test  \r\n\nalpha.test.ts\n  beta.test.ts \n\n'),
    ).toEqual({
      instruction: 'Fix the failing test',
      items: ['alpha.test.ts', 'beta.test.ts'],
    })
  })

  it('is null without an instruction and at least one item', () => {
    expect(parseFanOut('')).toBeNull()
    expect(parseFanOut('   \n \n')).toBeNull()
    expect(parseFanOut('Only an instruction')).toBeNull()
  })
})

describe('fanOutPrompt', () => {
  it('is the instruction, then the item, numbered', () => {
    expect(fanOutPrompt('Fix the failing test', 'beta.test.ts', 1, 3)).toBe(
      'Fix the failing test\n\nItem 2 of 3: beta.test.ts',
    )
  })
})

describe('runLabel', () => {
  it('is the instruction, cut to fit', () => {
    expect(runLabel('Short')).toBe('Short')
    expect(runLabel('x'.repeat(60), 10)).toBe('xxxxxxx...')
  })

  it('has a usage line that says how the draft is read', () => {
    expect(FAN_OUT_USAGE).toMatch(/first line, then one item per line/)
  })
})
