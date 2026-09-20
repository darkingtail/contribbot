import { readFileSync } from 'node:fs'
import { runCheck } from '../checks.js'

try {
  const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as unknown
  const result = await runCheck(input)
  console.log(JSON.stringify({ outcome: result.outcome }))
}
catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
}
