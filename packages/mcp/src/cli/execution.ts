import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { runLocalCommand } from '../core/execution/local.js'
import { assertLocalAction, describeLocalRequest, localHelp } from '../core/execution/request-help.js'

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' }, request: { type: 'string' }, 'data-root': { type: 'string' },
      help: { type: 'boolean' }, schema: { type: 'boolean' },
    },
  })
  if (values.help && values.schema) throw new Error('Choose --help or --schema, not both.')
  if (positionals.length > 1) throw new Error('Provide at most one action.')
  const action = positionals[0]
  if (action !== undefined) assertLocalAction(action)
  if (values.schema) {
    if (!action) throw new Error('Provide one action for --schema.')
    console.log(JSON.stringify(describeLocalRequest(action)))
  }
  else if (values.help) {
    console.log(localHelp(action))
  }
  else {
    if (!action || !values.repo || !values.request) throw new Error('Provide one action, --repo owner/repo and --request JSON file (or - for stdin).')
    const raw = readFileSync(values.request === '-' ? 0 : values.request, 'utf8')
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error('Request exceeds 2 MiB.')
    const payload: unknown = JSON.parse(raw)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Request must be a JSON object.')
    const result = await runLocalCommand({
      ...payload, action, repo: values.repo, ...(values['data-root'] ? { data_root: values['data-root'] } : {}),
    })
    console.log(JSON.stringify(result))
  }
}
catch (error) {
  console.log(JSON.stringify({ schema_version: 1, error: { code: 'execution_error', message: error instanceof Error ? error.message : String(error) } }))
  process.exitCode = 1
}
