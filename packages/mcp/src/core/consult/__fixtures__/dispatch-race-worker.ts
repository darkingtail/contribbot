import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { createConsultStore } from '../composition.js'

const [directory, discussionId, turnId, label, effectPath, readyPath, startPath, finishPath] = process.argv.slice(2)
if (!directory || !discussionId || !turnId || !label || !effectPath || !readyPath || !startPath || !finishPath) {
  throw new Error('Missing dispatch race fixture arguments.')
}

const store = createConsultStore(directory)
const wait = (path: string) => {
  const started = Date.now()
  while (!existsSync(path)) {
    if (Date.now() - started > 10_000) throw new Error(`Timed out waiting for ${path}.`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
}
writeFileSync(readyPath, label, { encoding: 'utf8', flag: 'wx' })
wait(startPath)
let dispatched = false
let error = null
try {
  store.dispatch(discussionId, turnId, () => {
    appendFileSync(effectPath, `${label}\n`, 'utf8')
    dispatched = true
    wait(finishPath)
  })
}
catch (caught) { error = caught instanceof Error ? caught.message : String(caught) }
process.stdout.write(JSON.stringify({ label, dispatched, error }))
