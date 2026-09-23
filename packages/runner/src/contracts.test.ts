import { expect, it } from 'vitest'
import { resultSchema } from 'contribbot-core'
import type { TurnResult } from 'contribbot-core'
import type { RuntimeOutcome } from 'contribbot-agent-runtime'

const outcome: RuntimeOutcome = {
  outcome: 'returned', text: 'Advice', stdout: 'provider output', stderr: '',
  exit_code: 0, signal: null, integrity: 'ok', reason: null, unresolved: [],
}

it('uses the unchanged domain result shape for the Runtime outcome', () => {
  const domain: TurnResult = outcome
  const runtime: RuntimeOutcome = domain
  expect(resultSchema.parse(runtime)).toEqual(outcome)
  for (const variant of [
    { ...outcome, outcome: 'failed', text: null, reason: 'Protocol incomplete', unresolved: ['Remote status unknown'] },
    { ...outcome, outcome: 'cancelled', text: null, signal: 'SIGTERM' },
  ]) expect(resultSchema.parse(variant)).toEqual(variant)
})

it('rejects malformed outcomes rather than silently changing fields during ingestion', () => {
  for (const invalid of [
    { ...outcome, outcome: 'success' },
    { ...outcome, integrity: 'complete' },
    { ...outcome, unresolved: null },
    { ...outcome, text: undefined },
    { ...outcome, todo_done: true },
  ]) expect(() => resultSchema.parse(invalid)).toThrow()
})
