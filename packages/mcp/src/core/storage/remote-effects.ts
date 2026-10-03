import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { repositoryRefSchema } from '../utils/repository-ref.js'
import { safeWriteFileSync } from '../utils/fs.js'
import { withTodoLock } from './todo-lock.js'

const text = z.string().min(1).max(65_536)
const identity = { execution_id: text.nullable(), repo: repositoryRefSchema }
const requestSchema = z.discriminatedUnion('kind', [
  z.object({ ...identity, kind: z.literal('pr'), payload: z.object({
    title: text, head: text, base: text, body: z.string().max(1_048_576), draft: z.boolean(),
  }).strict() }).strict(),
  z.object({ ...identity, kind: z.literal('claim'), payload: z.object({
    issue_number: z.number().int().positive(), marker: text, user: text,
    items: z.array(text).min(1).max(1024), body: z.string().max(1_048_576),
  }).strict() }).strict(),
])
const receiptSchema = z.object({ number: z.number().int().positive(), raw: z.record(z.unknown()) }).strict()
const effectSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), request: requestSchema,
  state: z.enum(['pending', 'received', 'linked']), started_at: z.string().datetime(),
  receipt: receiptSchema.nullable(),
}).strict()
const journalSchema = z.object({ version: z.literal(1), todo_id: text, effects: z.array(effectSchema).max(1024) }).strict()
export type RemoteEffectRequest = z.infer<typeof requestSchema>
export type RemoteEffect = z.infer<typeof effectSchema>
const maxBytes = 8 * 1024 * 1024

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(',')}}`
  return JSON.stringify(value)
}

export function remoteEffectId(todoId: string, request: RemoteEffectRequest): string {
  return createHash('sha256').update(`${todoId}\0${canonical(requestSchema.parse(request))}`).digest('hex')
}

export class RemoteEffects {
  private path: string
  private root: string
  private directory: string
  private todoId: string
  constructor(directory: string, todoId: string) {
    this.directory = directory
    this.todoId = todoId
    this.root = join(directory, '.operations')
    this.path = join(this.root, `remote-${createHash('sha256').update(todoId).digest('hex')}.json`)
  }

  private read() {
    if (existsSync(this.root)) {
      const root = lstatSync(this.root)
      if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('Remote effect directory must be a regular directory.')
    }
    if (!existsSync(this.path)) return journalSchema.parse({ version: 1, todo_id: this.todoId, effects: [] })
    const stat = lstatSync(this.path)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) throw new Error('Invalid remote effect journal.')
    const journal = journalSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
    if (journal.todo_id !== this.todoId || new Set(journal.effects.map(item => item.id)).size !== journal.effects.length) {
      throw new Error('Remote effect journal identity mismatch.')
    }
    for (const effect of journal.effects) {
      if (effect.id !== remoteEffectId(this.todoId, effect.request) || (effect.state === 'pending') !== (effect.receipt === null)) {
        throw new Error('Remote effect journal content mismatch.')
      }
      if (effect.receipt && effect.receipt.raw[effect.request.kind === 'pr' ? 'number' : 'id'] !== effect.receipt.number) {
        throw new Error('Remote receipt does not match its original result.')
      }
    }
    return journal
  }

  private save(journal: z.infer<typeof journalSchema>) {
    const content = JSON.stringify(journalSchema.parse(journal), null, 2)
    if (Buffer.byteLength(content) > maxBytes) throw new Error('Remote effect journal size limit exceeded; no new request admitted.')
    mkdirSync(this.root, { recursive: true })
    safeWriteFileSync(this.path, content)
  }

  list(): RemoteEffect[] { return withTodoLock(this.directory, () => this.read().effects) }

  find(request: RemoteEffectRequest): RemoteEffect | undefined {
    return this.list().find(effect => effect.id === remoteEffectId(this.todoId, request))
  }

  reserve(raw: RemoteEffectRequest): RemoteEffect {
    return withTodoLock(this.directory, () => {
      const request = requestSchema.parse(raw)
      const journal = this.read()
      const id = remoteEffectId(this.todoId, request)
      if (journal.effects.some(effect => effect.id === id)) throw new Error('Remote request already admitted; recover its original result without redispatch.')
      if (journal.effects.some(effect => effect.state !== 'linked')) throw new Error('Unresolved remote effects must be recovered before another remote request.')
      const effect: RemoteEffect = { id, request, state: 'pending', started_at: new Date().toISOString(), receipt: null }
      journal.effects.push(effect)
      this.save(journal)
      return effect
    })
  }

  receive(id: string, number: number, raw: Record<string, unknown>): RemoteEffect {
    return withTodoLock(this.directory, () => {
      const journal = this.read()
      const effect = journal.effects.find(effect => effect.id === id)
      if (!effect) throw new Error('Unknown original remote effect.')
      const receipt = receiptSchema.parse({ number, raw })
      if (raw[effect.request.kind === 'pr' ? 'number' : 'id'] !== number) throw new Error('Remote response identity mismatch.')
      if (effect.receipt) {
        if (effect.receipt.number !== number) throw new Error('Conflicting remote result identity.')
        return effect
      }
      effect.receipt = receipt
      effect.state = 'received'
      this.save(journal)
      return effect
    })
  }

  linked(id: string): void {
    withTodoLock(this.directory, () => {
      const journal = this.read()
      const effect = journal.effects.find(effect => effect.id === id)
      if (!effect?.receipt) throw new Error('Original remote receipt required before local linkage settlement.')
      if (effect.state === 'linked') return
      effect.state = 'linked'
      this.save(journal)
    })
  }
}

/** Called under the Todo mutex before releasing or replacing task ownership. */
export function assertRemoteEffectsSettled(directory: string, todoId: string | undefined): void {
  if (!todoId) return
  const pending = new RemoteEffects(directory, todoId).list().filter(effect => effect.state !== 'linked')
  if (pending.length) throw new Error(`Unresolved remote effects: ${pending.map(effect => `${effect.request.kind}:${effect.id}`).join(', ')}. Recover original results; do not redispatch.`)
}
