import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ExecutionArtifacts } from '../artifacts.js'
import { recordCheckReport } from '../reports.js'

const [requestFile, gateDirectory, name, pausePublication, stall] = process.argv.slice(2) as [string, string, string, string, string]
const request = JSON.parse(readFileSync(requestFile, 'utf8'))
const wait = (stage: string) => {
  writeFileSync(join(gateDirectory, `${name}-${stage}.ready`), String(process.pid))
  const deadline = Date.now() + 15000
  while (!existsSync(join(gateDirectory, `${stage}.release`))) {
    if (Date.now() >= deadline) throw new Error(`Fixture gate timed out: ${stage}`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
}
const publish = ExecutionArtifacts.prototype.putReceipt
ExecutionArtifacts.prototype.putReceipt = function (operation, value, namespace) {
  if (pausePublication === 'yes' && (namespace === undefined || namespace === 'result')) wait('publication')
  return publish.call(this, operation, value, namespace)
}
try {
  wait('start')
  if (stall === 'yes') {
    writeFileSync(join(gateDirectory, `${name}-stalled.ready`), String(process.pid))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  }
  const result = recordCheckReport(request)
  console.log(JSON.stringify({ ok: true, revision: result.revision }))
}
catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
}
