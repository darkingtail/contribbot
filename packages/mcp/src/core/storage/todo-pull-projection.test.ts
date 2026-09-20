import { describe, expect, it } from 'vitest'
import { renderTodoWorkflow } from './todo-projection.js'
import type { TodoItem } from './todo-store.js'

function todo(fields: Partial<TodoItem> = {}): TodoItem {
  return { id: 't-fixture', ref: 'projection', title: 'Projection', type: 'docs',
    status: 'active', difficulty: null, pr: 43, branch: null, claimed_items: null,
    created: '2026-09-18', updated: '2026-09-18', executions: [], ...fields }
}

describe('compatibility PR document projection', () => {
  it('does not omit a scalar-only association when explicit relations also exist', () => {
    const item = todo({ pull_requests: [{ repo: 'owner/repo', number: 41 }, { repo: 'owner/repo', number: 42 }] })
    const before = structuredClone(item)
    const document = renderTodoWorkflow(item)
    for (const number of [41, 42, 43]) expect(document).toContain(`#${number}`)
    expect(document).toContain('Legacy scalar PR')
    expect(document).toContain('not an additional PR or acceptance result')
    expect(item).toEqual(before)
  })

  it('displays a scalar-only legacy relation without guessing the canonical repository', () => {
    const document = renderTodoWorkflow(todo())
    expect(document).toContain('#43')
    expect(document).toContain('repository not embedded')
    expect(document).not.toContain('github.com')
  })

  it('does not conflate an explicit external PR with the same-number legacy project PR', () => {
    const document = renderTodoWorkflow(todo({ pull_requests: [{ repo: 'other/project', number: 43 }] }))
    expect(document).toContain('other/project')
    expect(document).toContain('Legacy scalar PR')
    expect(document.match(/#43/g)).toHaveLength(2)
  })

  it.each([null, 0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('does not render invalid legacy scalar %s as a PR', (pr) => {
    expect(renderTodoWorkflow(todo({ pr }))).not.toContain('Legacy scalar PR')
  })
})
