import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { TodoStore } from '../../storage/todo-store.js'
import type { WorkflowRequest } from '../contracts.js'

const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as {
  directory: string
  todo_id: string
  execution_id: string
  request: WorkflowRequest
  ready: string
  gate: string
  written: string
  actor: string
  crash?: 'before-save' | 'after-save'
}
const store = new TodoStore(input.directory)
if (input.crash) {
  const original = (store as unknown as { save: (todos: unknown) => void }).save.bind(store)
  ;(store as unknown as { save: (todos: unknown) => void }).save = todos => {
    if (input.crash === 'after-save') original(todos)
    process.exit(72)
  }
}
writeFileSync(input.ready, 'ready')
const deadline = Date.now() + 15_000
while (!existsSync(input.gate)) {
  if (Date.now() > deadline) throw new Error('Fixture start gate timed out.')
  await new Promise(resolve => setTimeout(resolve, 10))
}
try {
  store.applyWorkflow(input.todo_id, input.execution_id, input.request)
  appendFileSync(input.written, `${input.actor}\n`)
  process.stdout.write(JSON.stringify({ granted: true }))
}
catch (error) {
  process.stdout.write(JSON.stringify({ granted: false, error: error instanceof Error ? error.message : String(error) }))
}
