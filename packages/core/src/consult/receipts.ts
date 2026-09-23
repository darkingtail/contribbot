import type { Turn, TurnResult } from './contracts.js'
import type { ConsultStore } from './store.js'

export const failedResult = (reason: string, dispatchStartedAt: string | null = null): TurnResult => ({
  text: null, stdout: '', stderr: '', exit_code: null, signal: null,
  integrity: 'ok', outcome: 'failed', reason,
  unresolved: dispatchStartedAt
    ? ['Dispatch started; process liveness and outcome require observation of the original process.']
    : [],
})

/** Explicitly ingest a receipt already written by the original worker; never starts a Provider. */
export function recoverConsultTurn(store: ConsultStore, discussionId: string, turnId: string): Turn | null {
  const discussion = store.get(discussionId)
  const turn = discussion.turns.find(item => item.id === turnId)
  if (!turn) throw new Error('Consult turn not found.')
  if (turn.output_digest || turn.raw_purged) return turn
  if (turn.lifecycle === 'released_before_dispatch') {
    throw new Error('Consult turn was explicitly released before dispatch and cannot be recovered.')
  }
  const result = store.readResult(turn)
  if (result && !turn.claimed_at && !turn.dispatch_started_at) {
    throw new Error('Cannot recover a receipt for a turn that was never dispatched.')
  }
  return result ? store.settle(discussionId, turnId, result) : null
}
