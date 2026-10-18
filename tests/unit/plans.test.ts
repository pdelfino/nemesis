import { describe, expect, it, vi } from 'vitest'
import type {
  AgentEvent,
  PermissionDecision,
  PermissionHandler,
  PermissionRequest,
} from '../../src/main/agent/events'
import { mockDriver } from '../../src/main/agent/mock'
import { SessionManager } from '../../src/main/agent/session-manager'
import { createCockpitBuffers, type BufferRegistry } from '../../src/main/buffers'
import { CommandError } from '../../src/main/commands/registry'
import { parsePlanAnswer, PlanBuffers, planFeedback, planText } from '../../src/main/plans'

// The plan buffers (#82): ExitPlanMode is taken in front of the permission
// bridge and becomes an editable plan buffer; every other request passes
// through untouched.

const PLAN = '# Plan\n\n1. add a test\n2. Run the gate\n'

function request(
  toolName: string,
  input: Record<string, unknown>,
  controller = new AbortController(),
): PermissionRequest {
  return { toolName, toolUseId: 't1', input, signal: controller.signal }
}

interface Harness {
  readonly buffers: BufferRegistry
  readonly plans: PlanBuffers
  readonly next: ReturnType<
    typeof vi.fn<(request: PermissionRequest) => Promise<PermissionDecision>>
  >
  readonly leave: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly notices: string[]
  readonly shown: { bufferId: string; text: string }[]
}

function harness(): Harness {
  const buffers = createCockpitBuffers()
  const next = vi.fn<(request: PermissionRequest) => Promise<PermissionDecision>>(() =>
    Promise.resolve({ behavior: 'allow' }),
  )
  const leave = vi.fn<() => Promise<void>>(() => Promise.resolve())
  const handler: PermissionHandler = { requestPermission: next }
  const plans = new PlanBuffers(buffers, handler, { leavePlanMode: leave })
  const notices: string[] = []
  plans.on((event) => {
    if (event.type === 'notice') notices.push(event.text)
  })
  const shown: { bufferId: string; text: string }[] = []
  plans.onShown((content) => shown.push(content))
  return { buffers, plans, next, leave, notices, shown }
}

describe('the plan of an ExitPlanMode call', () => {
  it('is the plan the CLI injected, or nothing', () => {
    expect(planText({ plan: PLAN, planFilePath: '/x/plan.md' })).toBe(PLAN)
    expect(planText({ planFilePath: '/x/plan.md' })).toBe('')
    expect(planText({ plan: 42 })).toBe('')
  })

  it('goes back as feedback with the user words, or says there were none', () => {
    expect(planFeedback('  ')).toBe('The user rejected the plan in the cockpit without notes.')
    expect(planFeedback('Use vitest, not jest.\n')).toBe(
      'The user rejected the plan in the cockpit. The plan as they edited it, which is their feedback:\n\nUse vitest, not jest.',
    )
  })
})

describe('the plan buffers', () => {
  it('pass every other tool to the handler behind them, untouched', async () => {
    const { plans, next, buffers } = harness()
    const bash = request('Bash', { command: 'ls' })
    expect(await plans.requestPermission(bash)).toEqual({ behavior: 'allow' })
    expect(next).toHaveBeenCalledWith(bash)
    expect(buffers.list().map((buffer) => buffer.kind)).toEqual(['transcript', 'prompt'])
    expect(plans.pending).toEqual([])
  })

  it('open a plan buffer with the point and the text, and say so', async () => {
    const { plans, next, buffers, notices, shown } = harness()
    const pending = plans.requestPermission(request('ExitPlanMode', { plan: PLAN }))
    expect(next).not.toHaveBeenCalled()
    const buffer = buffers.current
    expect(buffer).toMatchObject({ kind: 'plan', title: 'Plan', elementId: 'plan' })
    expect(plans.pending).toEqual([{ bufferId: buffer?.id, text: PLAN }])
    expect(shown).toEqual([{ bufferId: buffer?.id, text: PLAN }])
    expect(notices).toEqual([
      'Plan received: C-c C-c in the plan buffer approves it as edited, C-c C-k rejects it with the text as feedback.',
    ])
    if (buffer === null) throw new Error('no plan buffer')
    plans.answer({ bufferId: buffer.id, outcome: 'approve', text: PLAN })
    await pending
  })

  it('approve an untouched plan as it was, leave plan mode and give the point back', async () => {
    const { plans, buffers, leave, notices } = harness()
    const prompt = buffers.current
    const pending = plans.requestPermission(request('ExitPlanMode', { plan: PLAN }))
    const buffer = buffers.current
    if (buffer === null || prompt === null) throw new Error('no buffers')
    plans.answer({ bufferId: buffer.id, outcome: 'approve', text: PLAN })
    expect(await pending).toEqual({ behavior: 'allow' })
    expect(leave).toHaveBeenCalledTimes(1)
    expect(buffers.get(buffer.id)).toBeUndefined()
    expect(buffers.current?.id).toBe(prompt.id)
    expect(plans.pending).toEqual([])
    expect(notices.at(-1)).toBe('Plan approved: the session leaves plan mode and starts the work.')
  })

  it('approve an edited plan with the text as the new plan, the rest of the input kept', async () => {
    const { plans, buffers, leave, notices } = harness()
    const pending = plans.requestPermission(
      request('ExitPlanMode', { plan: PLAN, planFilePath: '/x/plan.md' }),
    )
    const buffer = buffers.current
    if (buffer === null) throw new Error('no plan buffer')
    const edited = PLAN.replace('add a test', 'add a test in tests/unit')
    plans.answer({ bufferId: buffer.id, outcome: 'approve', text: edited })
    expect(await pending).toEqual({
      behavior: 'allow',
      updatedInput: { plan: edited, planFilePath: '/x/plan.md' },
    })
    expect(leave).toHaveBeenCalledTimes(1)
    expect(notices.at(-1)).toBe(
      'Plan approved as edited: the session leaves plan mode and starts the work.',
    )
  })

  it('reject with the edited text as feedback and stay in plan mode', async () => {
    const { plans, buffers, leave, notices } = harness()
    const pending = plans.requestPermission(request('ExitPlanMode', { plan: PLAN }))
    const buffer = buffers.current
    if (buffer === null) throw new Error('no plan buffer')
    plans.answer({ bufferId: buffer.id, outcome: 'reject', text: 'Too much. One step only.' })
    expect(await pending).toEqual({
      behavior: 'deny',
      message: planFeedback('Too much. One step only.'),
    })
    expect(leave).not.toHaveBeenCalled()
    expect(buffers.get(buffer.id)).toBeUndefined()
    expect(notices.at(-1)).toBe(
      'Plan rejected: the edited text went back as feedback; still in plan mode.',
    )
  })

  it('read a killed plan buffer as a rejection, so the agent never waits on it', async () => {
    const { plans, buffers, leave, notices } = harness()
    const pending = plans.requestPermission(request('ExitPlanMode', { plan: PLAN }))
    const buffer = buffers.current
    if (buffer === null) throw new Error('no plan buffer')
    buffers.kill(buffer.id)
    expect(await pending).toEqual({
      behavior: 'deny',
      message: 'The user closed the plan buffer without approving the plan; keep planning.',
    })
    expect(leave).not.toHaveBeenCalled()
    expect(notices.at(-1)).toBe('Plan buffer killed: the agent was told to keep planning.')
    expect(() => plans.answer({ bufferId: buffer.id, outcome: 'approve', text: '' })).toThrow(
      CommandError,
    )
  })

  it('settle a withdrawn request as denied and drop its buffer', async () => {
    const { plans, buffers } = harness()
    const controller = new AbortController()
    const pending = plans.requestPermission(request('ExitPlanMode', { plan: PLAN }, controller))
    const buffer = buffers.current
    controller.abort()
    expect(await pending).toMatchObject({ behavior: 'deny' })
    expect(buffer === null || buffers.get(buffer.id) === undefined).toBe(true)
    // Already aborted when asked: nothing opens.
    const dead = new AbortController()
    dead.abort()
    expect(await plans.requestPermission(request('ExitPlanMode', { plan: PLAN }, dead))).toEqual({
      behavior: 'deny',
      message: 'The plan request was withdrawn before the user answered.',
    })
    expect(buffers.list().map((buffer) => buffer.kind)).toEqual(['transcript', 'prompt'])
  })

  it('run the mock session through: the approved plan is the edited one and the mode leaves plan', async () => {
    const buffers = createCockpitBuffers()
    const deny: PermissionHandler = {
      requestPermission: () => Promise.resolve({ behavior: 'deny', message: 'no' }),
    }
    const plans: PlanBuffers = new PlanBuffers(buffers, deny, {
      leavePlanMode: (): Promise<void> => agent.leavePlanMode(),
    })
    const agent: SessionManager = new SessionManager({
      cwd: '/tmp/nemesis-unit',
      model: null,
      permissionHandler: plans,
      driver: mockDriver(),
    })
    const events: AgentEvent[] = []
    agent.on((event) => events.push(event))
    await agent.togglePlanMode()
    expect(agent.permissionMode).toBe('plan')
    const turn = new Promise<void>((resolve) => {
      agent.on((event) => {
        if (event.type === 'turn-end') resolve()
      })
    })
    await agent.send('plan: add a test')
    await vi.waitFor(() => expect(plans.pending).toHaveLength(1))
    const pending = plans.pending[0]
    if (pending === undefined) throw new Error('no pending plan')
    expect(pending.text).toBe(PLAN)
    plans.answer({
      bufferId: pending.bufferId,
      outcome: 'approve',
      text: pending.text.replace('add a test', 'add a test in tests/unit'),
    })
    await turn
    expect(agent.permissionMode).toBe('default')
    const texts = events.filter((event) => event.type === 'assistant-text')
    expect(texts.at(-1)).toEqual({
      type: 'assistant-text',
      text: 'Approved plan, as you edited it:\n# Plan\n\n1. add a test in tests/unit\n2. Run the gate\n',
    })
    expect(events.filter((event) => event.type === 'permission-mode')).toEqual([
      { type: 'permission-mode', mode: 'plan' },
      { type: 'permission-mode', mode: 'default' },
    ])
    await agent.stop()
  })
})

describe('a plan answer over IPC', () => {
  it('takes a buffer id, an outcome and the text, and nothing else', () => {
    expect(parsePlanAnswer({ bufferId: 'b3', outcome: 'approve', text: PLAN })).toEqual({
      bufferId: 'b3',
      outcome: 'approve',
      text: PLAN,
    })
    expect(parsePlanAnswer({ bufferId: 'b3', outcome: 'reject', text: '' })).toMatchObject({
      outcome: 'reject',
    })
    expect(() => parsePlanAnswer(null)).toThrow(TypeError)
    expect(() => parsePlanAnswer({ bufferId: '', outcome: 'approve', text: '' })).toThrow(TypeError)
    expect(() => parsePlanAnswer({ bufferId: 'b3', outcome: 'maybe', text: '' })).toThrow(TypeError)
    expect(() => parsePlanAnswer({ bufferId: 'b3', outcome: 'approve' })).toThrow(TypeError)
    expect(() =>
      parsePlanAnswer({ bufferId: 'b3', outcome: 'approve', text: 'x'.repeat(1_000_001) }),
    ).toThrow(TypeError)
  })
})
