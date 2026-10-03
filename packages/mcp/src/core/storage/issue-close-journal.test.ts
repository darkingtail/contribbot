import { describe, expect, it } from 'vitest'
import { parseIssueCloseReceipt } from './issue-close-journal.js'
import { fixtureRepository } from '../execution/__fixtures__/repository.js'

describe('Issue close journal lifecycle binding', () => {
  const identity = { repository: fixtureRepository('owner/repo'), issueNumber: 42, todoId: 't-example', executionId: null }
  const current = {
    ...identity, lifecycleRevision: 0, state: 'closed',
    startedAt: '2026-09-19T08:00:00.000Z', remoteClosedAt: '2026-09-19T08:01:00.000Z',
    dispatch: { version: 1 as const, initializedAt: '2026-09-19T08:00:00.000Z',
      commentDigest: '0'.repeat(64), effects: [] },
  }

  it('retains the exact revision for plain and managed receipts', () => {
    expect(parseIssueCloseReceipt(current, identity)).toEqual(current)
    const managed = { ...current, executionId: 'te-example', closureId: 'closing', lifecycleRevision: 7 }
    expect(parseIssueCloseReceipt(managed, { ...identity, executionId: 'te-example' })).toEqual(managed)
  })

  it.each([undefined, null, '0', -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid or missing lifecycle revision %j without defaulting', lifecycleRevision => {
      expect(() => parseIssueCloseReceipt({ ...current, lifecycleRevision }, identity)).toThrow(/lifecycle revision/)
    },
  )

  it('does not infer old missing journal fields from a remote close time', () => {
    const { state: _state, startedAt: _started, ...incomplete } = current
    expect(() => parseIssueCloseReceipt(incomplete, identity)).toThrow(/does not match/)
  })
})
