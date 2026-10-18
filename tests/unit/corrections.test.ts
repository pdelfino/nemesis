import { describe, expect, it } from 'vitest'
import {
  CorrectionCounter,
  isCorrection,
  NUDGE_AFTER,
  nudgeText,
} from '../../src/main/agent/corrections'

// The correction counter (#80): the guide's "correcting over and over",
// counted so the mode line can say when to clear instead of correcting again.
describe('what counts as a correction', () => {
  it('is a turn that opens with no or wrong, whatever the case', () => {
    expect(isCorrection('no, use the other file')).toBe(true)
    expect(isCorrection('No.')).toBe(true)
    expect(isCorrection('  WRONG again')).toBe(true)
    expect(isCorrection('wrong')).toBe(true)
  })

  it('is not a turn whose first word merely starts with them', () => {
    expect(isCorrection('nope')).toBe(false)
    expect(isCorrection('not that one')).toBe(false)
    expect(isCorrection('wrongly placed, but fine')).toBe(false)
    expect(isCorrection('fix the login bug')).toBe(false)
    expect(isCorrection('')).toBe(false)
  })
})

describe('the correction counter', () => {
  it('counts consecutive corrections and starts over at any other turn', () => {
    const counter = new CorrectionCounter()
    expect(counter.observe('do the thing')).toBe(0)
    expect(counter.observe('no, the other thing')).toBe(1)
    expect(counter.observe('wrong, I meant X')).toBe(2)
    expect(counter.observe('no!')).toBe(3)
    expect(counter.observe('thanks')).toBe(0)
    expect(counter.streak).toBe(0)
  })

  it('takes the correct command as a correction said in advance, once', () => {
    const counter = new CorrectionCounter()
    expect(counter.mark()).toBe(1)
    // The marked turn counts whatever its first word, and is not counted twice.
    expect(counter.observe('use the config from the env')).toBe(1)
    expect(counter.observe('no, the other env')).toBe(2)
    expect(counter.mark()).toBe(3)
    expect(counter.observe('no')).toBe(3)
  })

  it('starts over with the session', () => {
    const counter = new CorrectionCounter()
    counter.mark()
    counter.observe('no')
    counter.reset()
    expect(counter.streak).toBe(0)
    expect(counter.observe('anything')).toBe(0)
  })

  it('nudges at the second correction with the clear key named', () => {
    expect(NUDGE_AFTER).toBe(2)
    expect(nudgeText(2)).toBe(
      '2 corrections in a row: clear (C-c C-l) and start over with a better prompt that says what you learned.',
    )
  })
})
