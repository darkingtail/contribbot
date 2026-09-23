import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { types } from 'node:util'

interface Owner {
  token: string
  pid: number
  host: string
  created_at: string
}

interface Contender {
  token: string
  ticket: number | null
}

const owned = new Map<string, () => void>()
const sleeper = new Int32Array(new SharedArrayBuffer(4))

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) {
    return !(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')
  }
}

function contenders(root: string): Contender[] {
  const result: Contender[] = []
  for (const filename of readdirSync(root)) {
    if (!filename.startsWith('todos.') || filename.endsWith('.pending')) continue
    const match = /^todos\.(\d+)\.([a-f0-9-]+)\.(choosing|ticket-(\d+))\.json$/.exec(filename)
    if (!match) { result.push({ token: filename, ticket: null }); continue }
    const [, pidText, token, state, ticket] = match
    let owner: Partial<Owner>
    try { owner = JSON.parse(readFileSync(join(root, filename), 'utf8')) as Partial<Owner> }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue
      result.push({ token: token!, ticket: null })
      continue
    }
    if (owner.host !== hostname() || owner.pid !== Number(pidText) || owner.token !== token) {
      result.push({ token: token!, ticket: null })
      continue
    }
    if (!alive(owner.pid)) continue
    result.push({ token: token!, ticket: state === 'choosing' ? null : Number(ticket) })
  }
  return result
}

function publish(path: string, owner: Owner): void {
  const temporary = `${path}.pending`
  try {
    writeFileSync(temporary, JSON.stringify(owner), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  }
  finally { rmSync(temporary, { force: true }) }
}

function synchronous<T>(run: () => T): T {
  if (types.isAsyncFunction(run)) throw new Error('Todo transactions must be synchronous.')
  const result = run()
  if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
    throw new Error('Todo transactions must not return a Promise or thenable.')
  }
  return result
}

/**
 * Cross-process lock for the shared Todo/Consult data root.
 * The lock file names and transaction semantics are part of the local data contract.
 */
export function withTodoLock<T>(directory: string, run: () => T, timeoutMs = 10_000): T {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error('Todo lock timeout must be a nonnegative safe integer.')
  if (types.isAsyncFunction(run)) throw new Error('Todo transactions must be synchronous.')
  mkdirSync(directory, { recursive: true })
  const key = realpathSync(directory)
  const previous = owned.get(key)
  if (previous) { previous(); return synchronous(run) }

  const root = join(key, '.locks')
  mkdirSync(root, { recursive: true })
  const owner: Owner = { token: randomUUID(), pid: process.pid, host: hostname(), created_at: new Date().toISOString() }
  const choosing = join(root, `todos.${owner.pid}.${owner.token}.choosing.json`)
  let path: string | undefined
  const started = performance.now()
  publish(choosing, owner)
  try {
    const ticket = contenders(root).reduce((maximum, item) => Math.max(maximum, item.ticket ?? 0), 0) + 1
    if (!Number.isSafeInteger(ticket)) throw new Error('Todo lock ticket limit exceeded.')
    path = join(root, `todos.${owner.pid}.${owner.token}.ticket-${ticket}.json`)
    publish(path, owner)
    rmSync(choosing, { force: true })
    const assertOwned = () => {
      if (!path || readFileSync(path, 'utf8') !== JSON.stringify(owner)) throw new Error('Todo transaction lock lost.')
    }
    while (true) {
      assertOwned()
      const wait = contenders(root).some(item => item.token !== owner.token
        && (item.ticket === null || item.ticket < ticket || (item.ticket === ticket && item.token < owner.token)))
      if (!wait) break
      if (performance.now() - started >= timeoutMs) {
        throw new Error(`Timed out waiting for Todo transaction. Inspect ${root}; never remove live or unknown owners.`)
      }
      Atomics.wait(sleeper, 0, 0, 10)
    }
    owned.set(key, assertOwned)
    const result = synchronous(run)
    assertOwned()
    return result
  }
  finally {
    owned.delete(key)
    rmSync(choosing, { force: true })
    if (path) rmSync(path, { force: true })
  }
}
