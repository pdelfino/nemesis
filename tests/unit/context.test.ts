import { describe, expect, it } from 'vitest'
import {
  CONTEXT_FULL_PERCENT,
  CONTEXT_WARN_PERCENT,
  describeContext,
  describeCost,
  formatCost,
  formatTokens,
  levelOf,
} from '../../src/shared/context'

// The context meter (#80): the numbers of a usage event as the mode line
// shows them, with the color step where the guide says to clear or compact.
describe('the context meter', () => {
  it('spells tokens the way people say them', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(850)).toBe('850')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(2000)).toBe('2k')
    expect(formatTokens(150_000)).toBe('150k')
    expect(formatTokens(1_000_000)).toBe('1000k')
  })

  it('shows a fraction, a percentage and a ten-cell bar', () => {
    expect(describeContext(150_000, 200_000)).toEqual({
      text: '150k/200k 75% ████████░░',
      percent: 75,
      level: 'high',
    })
    expect(describeContext(2000, 200_000)).toEqual({
      text: '2k/200k 1% ░░░░░░░░░░',
      percent: 1,
      level: 'ok',
    })
    expect(describeContext(0, 0).text).toBe('0/0 0% ░░░░░░░░░░')
  })

  it('caps the bar when the window is over the limit', () => {
    expect(describeContext(220_000, 200_000)).toMatchObject({
      percent: 110,
      level: 'full',
      text: '220k/200k 110% ██████████',
    })
  })

  it('steps the color at the warning point and again near the top', () => {
    expect(levelOf(CONTEXT_WARN_PERCENT - 1)).toBe('ok')
    expect(levelOf(CONTEXT_WARN_PERCENT)).toBe('high')
    expect(levelOf(CONTEXT_FULL_PERCENT - 1)).toBe('high')
    expect(levelOf(CONTEXT_FULL_PERCENT)).toBe('full')
  })
})

// The cost next to the meter (#191): an estimate, so the sign says so.
describe('the session cost', () => {
  it('reads as an estimate in cents, a cheap turn not as free', () => {
    expect(formatCost(0)).toBe('≈$0.00')
    expect(formatCost(0.004)).toBe('<$0.01')
    expect(formatCost(0.42)).toBe('≈$0.42')
    expect(formatCost(12.5)).toBe('≈$12.50')
  })

  it('says in the tooltip it is the SDK estimate at list price, with the last turn', () => {
    expect(describeCost(0.04, 0.02)).toBe(
      "Session cost so far: $0.0400, the SDK's estimate at list price. Last turn: $0.0200.",
    )
  })
})
