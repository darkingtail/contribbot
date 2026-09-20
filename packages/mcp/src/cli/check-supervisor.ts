import { parseArgs } from 'node:util'
import { ExecutionArtifacts } from '../core/execution/artifacts.js'
import { executeReservedCheck } from '../core/execution/checks.js'

try {
  const { values } = parseArgs({
    options: {
      directory: { type: 'string' }, execution: { type: 'string' }, request: { type: 'string' },
    },
  })
  if (!values.directory || !values.execution || !values.request) throw new Error('Exact stored supervisor request required.')
  const request = new ExecutionArtifacts(values.directory, values.execution).get(values.request)
  if (!request || typeof request !== 'object' || !('directory' in request) || !('execution_id' in request)
    || request.directory !== values.directory || request.execution_id !== values.execution) {
    throw new Error('Supervisor request does not belong to its artifact store.')
  }
  await executeReservedCheck(request)
}
catch {
  // Results and recovery observations live in the operation artifacts, not detached stdout.
  process.exitCode = 1
}
