#!/usr/bin/env node
import { createAgentSession } from '../src/main/agent/session.ts'
import type { PermissionDecision, PermissionRequest } from '../src/main/agent/events'

/**
 * A headless check of the session manager against the real SDK (#58):
 *
 *   npm run agent:smoke -- "say hi"
 *
 * Node runs this file through its own type stripping, so there is no build
 * step and no Electron window between the SDK and the printed reply. The
 * package is CommonJS for Electron's sake, so the imported `.ts` files are
 * reparsed as modules; the npm script silences that one warning.
 * Authentication is whatever the `claude` CLI is logged in as; this script
 * reads no API key and sets none.
 *
 * The harness is unattended, so it denies every tool: it is here to prove the
 * stream works, never to let a prompt touch the machine.
 */

const prompt = process.argv.slice(2).join(' ').trim() || 'say hi'

const permissionHandler = {
  requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    console.log(`[permission] denied ${request.toolName} (the smoke harness runs no tools)`)
    return Promise.resolve({
      behavior: 'deny',
      message: 'The smoke harness denies every tool.',
    })
  },
}

const session = createAgentSession({ cwd: process.cwd(), permissionHandler })

session.on((event) => {
  switch (event.type) {
    case 'started':
      console.log(`[session] ${event.sessionId} model=${event.model} mode=${event.permissionMode}`)
      break
    case 'assistant-thinking':
      console.log(`[thinking] ${event.text}`)
      break
    case 'assistant-text':
      console.log(event.text)
      break
    case 'tool-use':
      console.log(`[tool] ${event.name} (${event.toolUseId})`)
      break
    case 'tool-result':
      console.log(`[tool-result] ${event.toolUseId}${event.isError ? ' (error)' : ''}`)
      break
    case 'error':
      console.error(`[error] ${event.message}`)
      break
    default:
      break
  }
})

try {
  await session.send(prompt)
  const turn = await session.waitForTurn()
  console.log(`[turn] ${turn.numTurns} turn(s) in ${turn.durationMs}ms`)
  process.exitCode = turn.isError ? 1 : 0
} catch (error) {
  console.error(`[smoke] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await session.stop()
}
