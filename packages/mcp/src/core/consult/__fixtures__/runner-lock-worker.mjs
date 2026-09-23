import { writeFileSync } from 'node:fs'
import { createConsultStore } from '../../../../../runner/src/composition.ts'

const [directory, discussionId, turnId, readyPath] = process.argv.slice(2)
const store = createConsultStore(directory)
writeFileSync(readyPath, 'ready')
const claimed = store.claim(discussionId, turnId, {
  pid: process.pid, machine: { hostname: 'fixture', platform: process.platform },
  started_at: null, observed_at: new Date().toISOString(),
})
console.log(JSON.stringify({ claimed, revision: store.get(discussionId).revision }))
