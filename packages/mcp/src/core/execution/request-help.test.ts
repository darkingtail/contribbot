import { describe, expect, it } from 'vitest'
import { hostActions, hostCommandSchema } from './local.js'
import { describeLocalRequest, localActions } from './request-help.js'

describe('public request structure', () => {
  it('keeps the public field surface stable without transport fields', () => {
    const fields = localActions.map(action => {
      const schema = describeLocalRequest(action) as unknown as {
        type: string; properties: Record<string, unknown>; required?: string[]
      }
      expect(schema.type).toBe('object')
      expect(schema.properties.repo).toMatchObject({ type: 'object', required: ['platform', 'instance', 'path'] })
      expect(schema.required).toContain('repo')
      for (const field of ['directory', 'data_root', 'action']) expect(schema.properties).not.toHaveProperty(field)
      return `${action}: ${Object.keys(schema.properties).sort().map(field =>
        `${field}${schema.required?.includes(field) ? '' : '?'}`).join(' ')}`
    }).join('\n')
    expect(fields).toMatchInlineSnapshot(`
      "context: execution_id? repo todo_id
      resume: execution_id? repo todo_id
      apply: command execution_id expected_revision repo request_id todo_id
      settle-pause: actor control_id execution_id expected_revision repo request_id todo_id
      continue: actor control_id decision execution_id expected_revision repo request_id todo_id
      cancel-close: actor closure_id control_id execution_id expected_revision note repo request_id todo_id
      bind: attempt_id execution_id expected_revision owner repo request_id todo_id workspace
      relocate: attempt_id decision execution_id expected_revision from_attempt owner plan_digest repo request_id todo_id workspace
      yield: actor execution_id expected_revision note observed_operations repo request_id todo_id
      inspect: execution_id repo todo_id
      check: acceptance_id actor execution_id expected_revision operation_id repo request_id todo_id
      observe: execution_id operation_id repo todo_id
      recover: acceptance_id actor execution_id expected_revision operation_id repo request_id todo_id
      reconcile: actor decision execution_id expected_revision operation_id repo report request_id todo_id
      reconcile-close: actor closure_id control_id? decision execution_id expected_revision repo report request_id todo_id
      report: acceptance_id actor attempt_id candidate epoch execution_id expected_revision locator observed_at operation_id outcome plan_id repo request_id source summary todo_id
      close: acknowledged_gaps closure_id decision execution_id expected_revision mode note repo target todo_id
      delegate-prepare: actor brief execution_id expected_revision operation_id provider purpose repo request_id scope step_id todo_id token tool workspace
      delegate-attach: actor execution_id expected_revision handle locator operation_id raw repo request_id todo_id
      delegate-observe: actor execution_id expected_revision handle locator observed_at operation_id quiescence raw repo request_id status todo_id tool
      delegate-collect: actor execution_id expected_revision operation_id repo request_id todo_id
      delegate-review: actor execution_id expected_revision locator note operation_id repo request_id result todo_id
      delegate-finish: actor decision execution_id expected_revision note operation_id repo request_id todo_id
      delegate-inspect: execution_id operation_id repo todo_id"
    `)
  })

  it('describes the same public command alternatives used by the runtime guard', () => {
    const schema = describeLocalRequest('apply') as unknown as {
      properties: { command: { anyOf: { properties: { action: { const: string } } }[] } }
    }
    const alternatives = schema.properties.command.anyOf.map(option => option.properties.action.const).sort()
    expect(alternatives).toEqual([...hostActions].sort())
    expect(alternatives).toEqual(hostCommandSchema.options.map(option => option.shape.action.value).sort())
    expect(hostCommandSchema.safeParse({ action: 'finish_closure', closure_id: 'fake' }).success).toBe(false)
  })

  it('exposes actual nested types and constraints, without pretending runtime refinements were converted', () => {
    const check = describeLocalRequest('check') as unknown as {
      additionalProperties: boolean; properties: Record<string, Record<string, unknown>>
    }
    expect(check.additionalProperties).toBe(false)
    expect(check.properties.expected_revision).toMatchObject({ type: 'integer', minimum: 0 })
    const report = describeLocalRequest('report') as unknown as {
      properties: { candidate: { required: string[] }; observed_at: { format: string } }
    }
    expect(report.properties.candidate.required).toEqual(['digest', 'root', 'git_dir', 'common_dir'])
    expect(report.properties.observed_at.format).toBe('date-time')
    expect(describeLocalRequest('apply')['x-contribbot'].validation).toBe('structure-only')
  })
})
