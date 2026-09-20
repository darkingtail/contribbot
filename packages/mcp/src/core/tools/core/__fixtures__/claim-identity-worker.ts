import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TodoStore } from '../../../storage/todo-store.js'
import { ensureClaimTodoIdentity } from '../todo-claim.js'

const [contribDir, owner, repo, ref, label, readyDir, logPath] = process.argv.slice(2)
if (!contribDir || !owner || !repo || !ref || !label || !readyDir || !logPath) {
  throw new Error('Expected contribDir, owner, repo, ref, label, readyDir and logPath.')
}

const store = new TodoStore(contribDir)
const snapshot = store.resolveItem(ref)?.item
if (!snapshot) throw new Error(`Todo not found: ${ref}`)

mkdirSync(readyDir, { recursive: true })
writeFileSync(join(readyDir, `${label}.ready`), '', { flag: 'wx' })
const deadline = Date.now() + 5_000
while (!existsSync(join(readyDir, 'a.ready')) || !existsSync(join(readyDir, 'b.ready'))) {
  if (Date.now() >= deadline) throw new Error('Timed out waiting for both identity workers.')
  await new Promise(resolve => setTimeout(resolve, 10))
}

const identified = await ensureClaimTodoIdentity(store, contribDir, owner, repo, snapshot)
appendFileSync(logPath, `${label}:${identified.id}\n`, 'utf-8')
