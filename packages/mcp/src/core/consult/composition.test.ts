import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import * as core from 'contribbot-core'
import * as contracts from './contracts.js'
import * as workflow from '../execution/workflow.js'
import * as coreWorkflow from 'contribbot-core/execution/workflow'
import * as executionContracts from '../execution/contracts.js'
import * as coreExecutionContracts from 'contribbot-core/execution/contracts'
import * as todos from '../storage/todo-store.js'
import * as coreRecords from 'contribbot-core/todo/records'
import * as enums from '../enums.js'
import * as coreEnums from 'contribbot-core/todo/enums'

it('keeps Todo storage and locking behind the shared Core composition adapter', () => {
  const storeSource = readFileSync(fileURLToPath(new URL('./store.ts', import.meta.url)), 'utf8')
  const compositionSource = readFileSync(fileURLToPath(new URL('./composition.ts', import.meta.url)), 'utf8')

  expect(storeSource).not.toMatch(/storage\/todo-store|storage\/todo-lock|execution\/workflow/)
  expect(compositionSource).not.toMatch(/storage\/todo-store|storage\/todo-lock|execution\/workflow/)
  expect(compositionSource).toMatch(/createFileTodoReadPort/)
  expect(compositionSource).toMatch(/withTodoLock/)
})

it('re-exports pure Consult contracts from the shared Core package', () => {
  expect(contracts.categorySchema).toBe(core.categorySchema)
  expect(contracts.decisionSchema).toBe(core.decisionSchema)
  expect(contracts.digest).toBe(core.digest)
  expect(contracts.digestSchema).toBe(core.digestSchema)
  expect(contracts.idSchema).toBe(core.idSchema)
  expect(contracts.manifestEntrySchema).toBe(core.manifestEntrySchema)
  expect(contracts.materialSchema).toBe(core.materialSchema)
  expect(contracts.MAX_PACKET_BYTES).toBe(core.MAX_PACKET_BYTES)
  expect(contracts.packetInputSchema).toBe(core.packetInputSchema)
  expect(contracts.packetSchema).toBe(core.packetSchema)
  expect(contracts.purposeSchema).toBe(core.purposeSchema)
  expect(contracts.scopeSchema).toBe(core.scopeSchema)
  expect(contracts.textSchema).toBe(core.textSchema)
})

it('keeps one implementation for the Todo read and workflow closure', () => {
  expect(workflow.normalizeWorkflow).toBe(coreWorkflow.normalizeWorkflow)
  expect(workflow.transitionWorkflow).toBe(coreWorkflow.transitionWorkflow)
  expect(workflow.planDigest).toBe(coreWorkflow.planDigest)
  expect(executionContracts.workflowSchema).toBe(coreExecutionContracts.workflowSchema)
  expect(executionContracts.processHandleSchema).toBe(coreExecutionContracts.processHandleSchema)
  expect(todos.currentTodoExecution).toBe(coreRecords.currentTodoExecution)
  expect(enums.TODO_STATUSES).toBe(coreEnums.TODO_STATUSES)
})
