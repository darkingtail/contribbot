import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { createComment, getCurrentUser, getIssue, getIssueComments } from '../../clients/github.js'
import { RecordFiles } from '../../storage/record-files.js'
import type { TodoItem } from '../../storage/todo-store.js'
import { currentTodoExecution, TodoStore } from '../../storage/todo-store.js'
import { getContribDir } from '../../utils/config.js'
import { todayDate } from '../../utils/format.js'
import { resolveRepo } from '../../utils/resolve-repo.js'
import { assertDispatchAllowed } from '../../execution/workflow.js'
import { isTerminalTodo } from '../../storage/todo-store.js'
import { RemoteEffects } from '../../storage/remote-effects.js'
import type { RemoteEffect, RemoteEffectRequest } from '../../storage/remote-effects.js'

function linkClaim(
  store: TodoStore, effects: RemoteEffects, todoId: string, executionId: string | null,
  items: string[], effect?: RemoteEffect,
): void {
  store.transaction(() => {
    const current = store.resolveItemById(todoId)
    if (!current) throw new Error(`todo ${todoId} changed or was removed`)
    if (effect && effects.list().find(item => item.id === effect.id)?.state === 'linked') return
    const merged = [...new Set([...(current.item.claimed_items ?? []), ...items])]
    const fields: Partial<Pick<TodoItem, 'claimed_items' | 'status'>> = { claimed_items: merged }
    const execution = currentTodoExecution(current.item)
    if ((execution?.id ?? null) === executionId && !isTerminalTodo(current.item)
      && !execution?.workflow?.control?.active_id && !execution?.workflow?.closing_id
      && current.item.status !== 'active') fields.status = 'active'
    if (!store.update(current.storeIndex, fields)) throw new Error(`todo ${todoId} could not be updated`)
    if (effect) effects.linked(effect.id)
  })
}

const DEFAULT_TEMPLATE = `<!--
  Claim 评论模板 — 发布到 GitHub issue 的评论内容
  可用变量：
    {{items}}  — 领取的工作项列表（markdown 列表格式）
    {{user}}   — GitHub 用户名
    {{repo}}   — 仓库（owner/repo）
    {{issue}}  — issue 编号
  注意：机器标记 contribbot:claim 由工具自动追加，不在模板中
-->
I'll work on the following:

{{items}}`

function loadTemplate(contribDir: string): string {
  const templateDir = join(contribDir, 'templates')
  const templatePath = join(templateDir, 'todo_claim.md')
  if (!existsSync(templatePath)) {
    if (!existsSync(templateDir)) mkdirSync(templateDir, { recursive: true })
    writeFileSync(templatePath, DEFAULT_TEMPLATE, 'utf-8')
  }
  // Strip leading HTML comment header (variable docs) before rendering
  return readFileSync(templatePath, 'utf-8')
    .replace(/^<!--[\s\S]*?-->\s*/m, '')
    .trim()
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`)
}

const CLAIM_LOCK_WAIT_MS = 15_000
const CLAIM_PROCESS_REUSE_CHECK_MS = CLAIM_LOCK_WAIT_MS * 2
const PROCESS_START_TOLERANCE_MS = 2_000
const processStartCache = new Map<number, { checkedAt: number; startedAt?: number }>()

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

interface ClaimLockOwner {
  token: string
  pid: number
  createdAt?: number
  choosing?: boolean
  ticket?: number
}

function readClaimLockOwner(ownerPath: string): ClaimLockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(ownerPath, 'utf-8')) as Partial<ClaimLockOwner> & { state?: string }
    if (typeof value.token !== 'string' || typeof value.pid !== 'number') return undefined
    return {
      token: value.token,
      pid: value.pid,
      createdAt: typeof value.createdAt === 'number' ? value.createdAt : undefined,
      choosing: typeof value.choosing === 'boolean'
        ? value.choosing
        : value.state === 'waiting',
      ticket: typeof value.ticket === 'number' && value.ticket >= 0
        ? value.ticket
        : 0,
    }
  }
  catch {
    return undefined
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    return code === 'EPERM'
  }
}

function processStartedAt(pid: number): number | undefined {
  if (pid === process.pid) return Date.now() - process.uptime() * 1_000

  const cached = processStartCache.get(pid)
  if (cached && Date.now() - cached.checkedAt < 1_000) return cached.startedAt

  let startedAt: number | undefined
  try {
    const output = process.platform === 'win32'
      ? execFileSync('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('O')`,
        ], { encoding: 'utf-8', windowsHide: true, timeout: 2_000 })
      : execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
          encoding: 'utf-8',
          timeout: 2_000,
          env: { ...process.env, LC_ALL: 'C' },
        })
    const parsed = Date.parse(output.trim())
    if (Number.isFinite(parsed)) startedAt = parsed
  }
  catch {
    // An unavailable process-inspection command must not weaken mutual exclusion.
  }

  processStartCache.set(pid, { checkedAt: Date.now(), startedAt })
  return startedAt
}

function isProcessIncarnationAlive(pid: number, contenderCreatedAt?: number): boolean {
  if (!isProcessAlive(pid)) return false
  if (
    contenderCreatedAt === undefined
    || Date.now() - contenderCreatedAt < CLAIM_PROCESS_REUSE_CHECK_MS
  ) {
    return true
  }

  const startedAt = processStartedAt(pid)
  return startedAt === undefined || startedAt <= contenderCreatedAt + PROCESS_START_TOLERANCE_MS
}

interface ClaimLockContender extends ClaimLockOwner {
  path: string
  choosing: boolean
  ticket: number
}

interface ClaimLockFileIdentity {
  token: string
  pid?: number
  choosing?: boolean
  ticket?: number
}

function claimLockFileIdentity(name: string, prefix: string): ClaimLockFileIdentity | undefined {
  if (!name.startsWith(prefix) || !name.endsWith('.json')) return undefined
  const suffix = name.slice(prefix.length)
  const choosing = suffix.match(/^(\d+)\.(.+)\.choosing\.json$/)
  if (choosing) {
    return { pid: Number.parseInt(choosing[1]!, 10), token: choosing[2]!, choosing: true, ticket: 0 }
  }
  const ticket = suffix.match(/^(\d+)\.(.+)\.ticket-(\d+)\.json$/)
  if (ticket) {
    return {
      pid: Number.parseInt(ticket[1]!, 10),
      token: ticket[2]!,
      choosing: false,
      ticket: Number.parseInt(ticket[3]!, 10),
    }
  }

  // Previous releases used one mutable JSON file whose name contained only a token.
  return { token: suffix.slice(0, -'.json'.length) }
}

function readContender(path: string, identity: ClaimLockFileIdentity): ClaimLockContender | undefined {
  try {
    const stats = statSync(path)
    const owner = readClaimLockOwner(path)
    if (owner) {
      if (!isProcessIncarnationAlive(owner.pid, owner.createdAt ?? stats.mtimeMs)) return undefined
      if (identity.pid !== undefined && (owner.pid !== identity.pid || owner.token !== identity.token)) {
        return { token: identity.token, pid: identity.pid, choosing: true, ticket: 0, path }
      }
      return {
        ...owner,
        choosing: identity.choosing ?? owner.choosing ?? false,
        ticket: identity.ticket ?? owner.ticket ?? 0,
        path,
      }
    }

    // New lock files encode their owner PID in the immutable filename. A malformed
    // file owned by a live process is an in-progress publication and must block.
    if (identity.pid !== undefined) {
      return isProcessIncarnationAlive(identity.pid, stats.mtimeMs)
        ? { token: identity.token, pid: identity.pid, choosing: true, ticket: 0, path }
        : undefined
    }

    // A malformed mutable file from an older release has no trustworthy owner.
    // Blocking until timeout is safer than allowing overlapping GitHub side effects.
    return { token: identity.token, pid: 0, choosing: true, ticket: 0, path }
  }
  catch {
    return undefined
  }
}

function liveClaimContenders(lockRoot: string, digest: string): ClaimLockContender[] {
  const prefix = `claim-${digest}.`
  const contenders: ClaimLockContender[] = []

  for (const name of readdirSync(lockRoot)) {
    const identity = claimLockFileIdentity(name, prefix)
    if (!identity) continue
    const path = join(lockRoot, name)
    const contender = readContender(path, identity)
    if (contender) contenders.push(contender)
  }

  // Old releases used one replaceable directory. Observe a live owner, but never
  // delete the path: deleting it after inspection has an unavoidable ABA race.
  const legacyPath = join(lockRoot, `claim-${digest}.lock`)
  if (existsSync(legacyPath)) {
    try {
      const legacyOwnerPath = join(legacyPath, 'owner.json')
      const legacyOwner = readClaimLockOwner(legacyOwnerPath)
      const legacyStats = statSync(legacyPath)
      const contender = legacyOwner
        ? (isProcessIncarnationAlive(legacyOwner.pid, legacyOwner.createdAt ?? legacyStats.mtimeMs)
            ? {
                ...legacyOwner,
                choosing: false,
                ticket: 0,
                createdAt: legacyOwner.createdAt ?? legacyStats.mtimeMs,
                path: legacyPath,
              }
            : undefined)
        : { token: `legacy:${digest}`, pid: 0, choosing: true, ticket: 0, createdAt: legacyStats.mtimeMs, path: legacyPath }
      if (contender) contenders.push(contender)
    }
    catch {
      // A legacy owner may remove its replaceable directory between observation and read.
    }
  }

  return contenders
}

export async function withClaimLock<T>(
  contribDir: string,
  digest: string,
  run: (assertOwned: () => void) => Promise<T>,
): Promise<T> {
  const lockRoot = join(contribDir, '.locks')
  mkdirSync(lockRoot, { recursive: true })
  const owner: ClaimLockOwner = {
    token: randomUUID(),
    pid: process.pid,
    createdAt: Date.now(),
  }
  const choosingPath = join(lockRoot, `claim-${digest}.${owner.pid}.${owner.token}.choosing.json`)
  writeFileSync(choosingPath, JSON.stringify({ ...owner, choosing: true, ticket: 0 }), { encoding: 'utf-8', flag: 'wx' })
  const startedAt = Date.now()
  let ticketPath: string | undefined

  const ownsLock = () => {
    if (!ticketPath) return false
    const current = readClaimLockOwner(ticketPath)
    return current?.token === owner.token
      && current.pid === owner.pid
      && current.ticket === owner.ticket
  }
  const assertOwned = () => {
    if (!ownsLock()) throw new Error('The todo_claim lock was lost while the operation was waiting. Retry the same request.')
  }

  try {
    const published = liveClaimContenders(lockRoot, digest)
      .filter(contender => contender.choosing === false)
    owner.ticket = published.reduce((max, contender) => Math.max(max, contender.ticket ?? 0), 0) + 1
    ticketPath = join(lockRoot, `claim-${digest}.${owner.pid}.${owner.token}.ticket-${owner.ticket}.json`)
    writeFileSync(ticketPath, JSON.stringify({ ...owner, choosing: false }), { encoding: 'utf-8', flag: 'wx' })
    rmSync(choosingPath, { force: true })

    while (true) {
      if (Date.now() - startedAt >= CLAIM_LOCK_WAIT_MS) {
        throw new Error('Timed out waiting for another todo_claim operation on this Todo to finish. Retry the same request.')
      }

      if (!ownsLock()) throw new Error('The todo_claim lock was lost before the operation started. Retry the same request.')
      const contenders = liveClaimContenders(lockRoot, digest)
      const mustWait = contenders.some(contender => {
        if (contender.token === owner.token && contender.path === ticketPath) return false
        if (contender.choosing) return true
        const ticket = contender.ticket ?? 0
        return ticket < owner.ticket!
          || (ticket === owner.ticket && contender.token.localeCompare(owner.token) < 0)
      })
      if (!mustWait) {
        return await run(assertOwned)
      }
      await sleep(25)
    }
  }
  finally {
    rmSync(choosingPath, { force: true })
    if (ticketPath) rmSync(ticketPath, { force: true })
  }
}

export async function ensureClaimTodoIdentity(
  store: TodoStore,
  contribDir: string,
  owner: string,
  repo: string,
  todo: TodoItem,
): Promise<TodoItem> {
  if (todo.id) return todo
  if (!todo.ref) throw new Error(`Todo "${todo.title}" has no ref and cannot receive a claim identity.`)

  const identityDigest = createHash('sha256')
    .update(`${owner}/${repo}\0legacy-claim-identity\0${todo.ref.toLowerCase()}`)
    .digest('hex')
    .slice(0, 16)

  return withClaimLock(contribDir, identityDigest, async (assertOwned) => {
    assertOwned()
    return store.transaction(() => {
      const current = store.resolveItem(todo.ref!)
      if (!current) throw new Error(`Todo "${todo.ref}" changed or was removed while assigning its stable claim identity.`)
      const identified = current.item.id ? current.item : store.ensureTodoId(current.storeIndex)
      assertOwned()
      if (!identified?.id) throw new Error(`Failed to assign a stable id to todo "${todo.ref}".`)
      return identified
    })
  })
}

export async function todoClaim(
  item: string,
  items: string[],
  repo?: string,
): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const contribDir = getContribDir(owner, name)
  const store = new TodoStore(contribDir)

  const resolved = store.resolveItem(item)
  if (!resolved) {
    throw new Error(`Todo not found: "${item}". Use todo_list to see available items.`)
  }

  const initialTodo = resolved.item

  if (!initialTodo.ref?.startsWith('#')) {
    throw new Error(`Todo "${initialTodo.title}" has no issue ref — nothing to claim on GitHub.`)
  }

  const todo = await ensureClaimTodoIdentity(store, contribDir, owner, name, initialTodo)
  const todoId = todo.id!
  const executionId = currentTodoExecution(todo)?.id ?? null
  const issueRef = todo.ref
  if (!issueRef?.startsWith('#')) {
    throw new Error(`Todo ${todoId} changed its issue ref while assigning its stable claim identity.`)
  }

  new RecordFiles(contribDir).ensureTodoRecord(
    issueRef,
    todo.title,
    todo.type,
    todayDate(),
    todoId,
    { adoptUnowned: !store.hasArchivedRef(issueRef, todoId) },
  )

  if (items.length === 0) {
    throw new Error('No items specified. Provide at least one item to claim.')
  }

  const issueNumber = Number.parseInt(issueRef.slice(1), 10)
  const effects = new RemoteEffects(contribDir, todoId)
  const normalizedItems = JSON.stringify(items.map(item => item.trim()).sort())
  const saved = effects.list().find(effect => effect.request.kind === 'claim'
    && effect.request.repo === `${owner}/${name}` && effect.request.payload.issue_number === issueNumber
    && (effect.request.execution_id === executionId || effect.state !== 'linked')
    && Array.isArray(effect.request.payload.items)
    && JSON.stringify((effect.request.payload.items as string[]).map(item => item.trim()).sort()) === normalizedItems)
  if (saved?.request.kind === 'claim') {
    // Original-result recovery does not require the Issue to remain open or another POST.
    const marker = saved.request.payload.marker
    let received = saved
    if (!received.receipt) {
      const comments = await getIssueComments(owner, name, issueNumber)
      const original = comments.filter(comment => comment.body.includes(marker))
      if (original.length !== 1) throw new Error(`Claim request ${saved.id} remains unresolved. Recover the original comment; no new claim was dispatched.`)
      received = effects.receive(saved.id, original[0]!.id, original[0]! as unknown as Record<string, unknown>)
    }
    linkClaim(store, effects, todoId, saved.request.execution_id, saved.request.payload.items as string[], received)
    return `Recovered claim comment #${received.receipt!.number} on ${owner}/${name}#${issueNumber}; no new comment posted.`
  }

  const [issue, user] = await Promise.all([
    getIssue(owner, name, issueNumber),
    getCurrentUser(),
  ])
  if (issue.state === 'closed') {
    throw new Error(`Issue ${issueRef} is closed — cannot claim on a closed issue.`)
  }

  if (!user?.login) {
    throw new Error('Cannot determine GitHub username. Check authentication (gh auth status or GITHUB_TOKEN).')
  }

  const beforeComment = store.resolveItemById(todoId)
  if (!beforeComment) throw new Error(`Todo ${todoId} changed or was removed while claim preparation was waiting for GitHub.`)
  if ((currentTodoExecution(beforeComment.item)?.id ?? null) !== executionId) {
    throw new Error(`Todo ${todoId} changed execution while claim preparation was waiting for GitHub.`)
  }

  const itemsList = items.map(s => `- ${s}`).join('\n')
  const template = loadTemplate(contribDir)
  const rendered = renderTemplate(template, {
    items: itemsList,
    user: user.login,
    repo: `${owner}/${name}`,
    issue: String(issueNumber),
  })

  const operationDigest = createHash('sha256')
    .update(JSON.stringify({
      issue: `${owner}/${name}#${issueNumber}`,
      user: user.login,
      todoId,
      items: items.map(value => value.trim()).sort(),
    }))
    .digest('hex')
    .slice(0, 16)
  const operationMarker = `<!-- contribbot:claim-op @${user.login} ${todoId} ${operationDigest} -->`
  const lockDigest = createHash('sha256')
    .update(`${owner}/${name}#${issueNumber}\0${todoId}`)
    .digest('hex')
    .slice(0, 16)
  const result = await withClaimLock(contribDir, lockDigest, async (assertOwned) => {
    const lockedTodo = store.resolveItemById(todoId)
    if (!lockedTodo) throw new Error(`Todo ${todoId} changed or was removed while waiting for an identical claim operation.`)
    if ((currentTodoExecution(lockedTodo.item)?.id ?? null) !== executionId) {
      throw new Error(`Todo ${todoId} changed execution while waiting for an identical claim operation.`)
    }

    const comments = await getIssueComments(owner, name, issueNumber)
    assertOwned()
    const existingComment = comments.find(comment => comment.body.includes(operationMarker))
    const existingClaims = lockedTodo.item.claimed_items
    const warning = existingClaims && existingClaims.length > 0
      ? `\n\n> Merged with ${existingClaims.length} previously claimed item(s).`
      : ''

    // Keep the original marker for activation-time claim discovery and add an idempotency marker for retries.
    const body = `${rendered}\n\n<!-- contribbot:claim @${user.login} -->\n${operationMarker}`
    const request: RemoteEffectRequest = { kind: 'claim', execution_id: executionId, repo: `${owner}/${name}`,
      payload: { issue_number: issueNumber, marker: operationMarker, items, user: user.login, body } }
    let effect = effects.list().find(effect => effect.request.kind === 'claim'
      && effect.request.execution_id === executionId && effect.request.payload.marker === operationMarker)
    let commentId = existingComment?.id
    let commentState = 'already existed'
    if (effect?.receipt) {
      commentId = effect.receipt.number
      commentState = 'recovered'
    }
    else if (existingComment) {
      if (effect) effect = effects.receive(effect.id, existingComment.id, existingComment as unknown as Record<string, unknown>)
    }
    else {
      assertOwned()
      if (effect) throw new Error(`Claim request ${effect.id} remains unresolved. Recover the original comment; an absent marker is not permission to post again.`)
      const submitted = store.transaction(() => {
        const current = store.resolveItemById(todoId)?.item
        if (!current || (currentTodoExecution(current)?.id ?? null) !== executionId) throw new Error('Todo changed before claim submission.')
        const state = currentTodoExecution(current)?.workflow
        if (state) assertDispatchAllowed(state)
        if (isTerminalTodo(current)) throw new Error('Reopen the terminal Todo before posting a new claim.')
        effect = effects.reserve(request)
        return { result: createComment(owner, name, issueNumber, body) }
      })
      const posted = await submitted.result
      effect = effects.receive(effect!.id, posted.id, posted as unknown as Record<string, unknown>)
      commentId = posted.id
      commentState = 'was posted'
    }

    try {
      assertOwned()
      linkClaim(store, effects, todoId, executionId, items, effect)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const commentLabel = commentId == null ? 'Claim comment' : `Claim comment #${commentId}`
      throw new Error(
        `${commentLabel} ${commentState} on ${owner}/${name}#${issueNumber}, but the local claim update failed: ${message}. `
        + `Retry the same todo_claim request as todo_claim(item="${todoId}", items=${JSON.stringify(items)}, repo="${owner}/${name}"); its operation marker prevents a duplicate comment.`,
      )
    }

    return { existingComment: Boolean(existingComment), warning }
  })

  return [
    `Claimed ${items.length} item(s) on ${issueRef}:`,
    '',
    itemsList,
    '',
    `Comment ${result.existingComment ? 'already existed' : 'posted'} on ${owner}/${name}#${issueNumber}`,
    result.warning,
  ].join('\n').trim()
}
