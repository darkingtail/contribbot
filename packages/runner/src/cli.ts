#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { inspectProviderBinding } from 'contribbot-agent-runtime'
import { idSchema, MAX_PACKET_BYTES, readBounded, reconcileInputSchema } from 'contribbot-core'
import { recoverConsultTurn } from './consult.js'
import { createConsultStore } from './composition.js'
import { launchConsultWorker } from './supervisor.js'

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}.`)
  return value
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      schema: { type: 'boolean' },
      runtime: { type: 'string' }, executable: { type: 'string' }, model: { type: 'string' },
      directory: { type: 'string' }, discussion: { type: 'string' }, turn: { type: 'string' },
      request: { type: 'string' }, 'expected-revision': { type: 'string' },
    },
  })
  const commands = ['provider inspect', 'consult start', 'consult recover', 'consult observe', 'consult reconcile']
  const [area, action] = positionals
  const optionsFor = (allowed: string[]) => {
    for (const name of Object.keys(values)) {
      if (!allowed.includes(name)) throw new Error(`Option --${name} is not valid for this command.`)
    }
  }
  if (values.schema && positionals.length === 0) {
    optionsFor(['schema'])
    console.log(JSON.stringify({ schema_version: 1, kind: 'contribbot-runner', commands }))
  }
  else if (positionals.length !== 2 || !commands.includes(`${area} ${action}`)) {
    throw new Error('Usage: contribbot-run --schema | provider inspect --runtime <provider> --executable <path> | consult start|recover|observe|reconcile --directory <path> --discussion <id> --turn <id>. Observe requires --expected-revision; reconcile requires --request <JSON file>.')
  }
  else if (area === 'provider') {
    optionsFor(['runtime', 'executable', 'model'])
    const runtime = required(values.runtime, '--runtime')
    const result = await inspectProviderBinding({
      runtime, executable: required(values.executable, '--executable'), model: values.model,
    })
    console.log(JSON.stringify({ schema_version: 1, binding: result }))
  }
  else {
    optionsFor(['directory', 'discussion', 'turn',
      ...(action === 'observe' ? ['expected-revision'] : []),
      ...(action === 'reconcile' ? ['request'] : [])])
    const store = createConsultStore(required(values.directory, '--directory'))
    const discussionId = idSchema.parse(required(values.discussion, '--discussion'))
    const turnId = idSchema.parse(required(values.turn, '--turn'))
    if (action === 'start') {
      if (!store.get(discussionId).turns.some(turn => turn.id === turnId)) throw new Error('Consult turn not found.')
      await launchConsultWorker(store.directory, discussionId, turnId)
      console.log(JSON.stringify({
        schema_version: 1, status: 'worker_started', discussion_id: discussionId, turn_id: turnId,
        note: 'Worker process started; claim and provider execution are reported by consult_status.',
      }))
    }
    else if (action === 'recover') {
      const turn = recoverConsultTurn(store, discussionId, turnId)
      console.log(JSON.stringify({ schema_version: 1, recovered: Boolean(turn?.output_digest), turn }))
    }
    else if (action === 'observe') {
      const revision = required(values['expected-revision'], '--expected-revision')
      if (!/^(0|[1-9]\d*)$/.test(revision) || !Number.isSafeInteger(Number(revision))) {
        throw new Error('Expected revision must be a nonnegative safe integer.')
      }
      const observation = store.observeRelease(discussionId, turnId, Number(revision))
      console.log(JSON.stringify({ schema_version: 1, observation }))
    }
    else if (action === 'reconcile') {
      const request = reconcileInputSchema.parse(JSON.parse(readBounded(required(values.request, '--request'), MAX_PACKET_BYTES).toString('utf8')))
      const turn = store.reconcile(discussionId, turnId, request)
      console.log(JSON.stringify({ schema_version: 1, turn }))
    }
  }
}
catch (error) {
  console.log(JSON.stringify({ schema_version: 1, error: { code: 'runner_error', message: error instanceof Error ? error.message : String(error) } }))
  process.exitCode = 1
}
