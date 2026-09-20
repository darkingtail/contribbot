import { appendFileSync } from 'node:fs'
import { withClaimLock } from '../todo-claim.js'

const [contribDir, digest, label, holdMsValue, logPath] = process.argv.slice(2)
if (!contribDir || !digest || !label || !holdMsValue || !logPath) {
  throw new Error('Expected contribDir, digest, label, holdMs and logPath.')
}

await withClaimLock(contribDir, digest, async (assertOwned) => {
  assertOwned()
  appendFileSync(logPath, `start:${label}\n`, 'utf-8')
  await new Promise(resolve => setTimeout(resolve, Number.parseInt(holdMsValue, 10)))
  assertOwned()
  appendFileSync(logPath, `end:${label}\n`, 'utf-8')
})
