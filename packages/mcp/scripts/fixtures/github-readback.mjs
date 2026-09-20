import { appendFileSync, readFileSync } from 'node:fs'

// Preloaded only by the isolated execution smoke fixture. Never forward requests.
const statePath = process.env.CONTRIBBOT_SMOKE_GITHUB_STATE
const callsPath = process.env.CONTRIBBOT_SMOKE_GITHUB_CALLS
if (!statePath || !callsPath) throw new Error('Missing isolated GitHub fixture paths.')
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input))
  if (url.origin !== 'https://api.github.com' || (init?.method ?? 'GET') !== 'GET') {
    throw new Error('The fixture permits only simulated GitHub GET requests.')
  }
  appendFileSync(callsPath, `${url.pathname}\n`)
  const routes = JSON.parse(readFileSync(statePath, 'utf8'))
  const response = routes[url.pathname]
  if (!response) throw new Error('No fixture route; network forwarding is disabled.')
  return new Response(JSON.stringify(response.body), { status: response.status ?? 200 })
}
