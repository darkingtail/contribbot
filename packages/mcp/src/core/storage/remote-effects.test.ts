import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RemoteEffects, assertRemoteEffectsSettled } from './remote-effects.js'
import type { RemoteEffectRequest } from './remote-effects.js'
import { fixtureRepository } from '../execution/__fixtures__/repository.js'

describe('closed-kind remote effect journal', () => {
  let directory: string
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'contribbot-remote-effects-')) })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
  const request: RemoteEffectRequest = { kind: 'pr', execution_id: null, repo: fixtureRepository('fixture/repo'),
    payload: { title: 'Change', head: 'feature/change', base: 'main', body: '', draft: false } }

  it('keeps admission, receipt and local linkage separate across a new reader', () => {
    const effects = new RemoteEffects(directory, 'todo')
    const pending = effects.reserve(request)
    expect(new RemoteEffects(directory, 'todo').list()).toEqual([pending])
    expect(() => assertRemoteEffectsSettled(directory, 'todo')).toThrow(/remote effects/i)
    effects.receive(pending.id, 1, { number: 1, body: 'original' })
    expect(() => assertRemoteEffectsSettled(directory, 'todo')).toThrow(/remote effects/i)
    effects.linked(pending.id)
    expect(() => assertRemoteEffectsSettled(directory, 'todo')).not.toThrow()
    expect(() => effects.reserve(request)).toThrow(/already admitted/i)
  })

  it('binds remote correlation to the stable Todo even without an execution', () => {
    const first = new RemoteEffects(directory, 'first').reserve(request)
    const second = new RemoteEffects(directory, 'second').reserve(request)
    expect(first.id).not.toBe(second.id)
  })

  it('cannot bypass uncertainty with a changed request or erase it with YAML rewrites', () => {
    const effects = new RemoteEffects(directory, 'todo')
    effects.reserve(request)
    writeFileSync(join(directory, 'todos.yaml'), 'todos: []\n')
    expect(() => effects.reserve({ ...request, payload: { ...request.payload, title: 'Other' } })).toThrow(/unresolved/i)
    expect(() => assertRemoteEffectsSettled(directory, 'todo')).toThrow(/remote effects/i)
  })

  it('retains original response on exact replay and refuses a conflicting result', () => {
    const effects = new RemoteEffects(directory, 'todo')
    const pending = effects.reserve(request)
    effects.receive(pending.id, 2, { number: 2, body: 'original' })
    effects.receive(pending.id, 2, { number: 2, body: 'later remote edits' })
    expect(effects.list()[0]!.receipt!.raw.body).toBe('original')
    expect(() => effects.receive(pending.id, 3, { number: 3 })).toThrow(/conflicting/i)
    expect(() => effects.receive(pending.id, 2, { number: 7 })).toThrow(/identity/i)
  })

  it('fails closed on corrupt journal state instead of treating it as no pending work', () => {
    const effects = new RemoteEffects(directory, 'todo')
    effects.reserve(request)
    const path = join(directory, '.operations', readdirSync(join(directory, '.operations'))[0]!)
    const data = JSON.parse(readFileSync(path, 'utf8'))
    data.effects[0].state = 'linked'
    writeFileSync(path, JSON.stringify(data))
    expect(() => assertRemoteEffectsSettled(directory, 'todo')).toThrow(/content mismatch/i)
  })
})
