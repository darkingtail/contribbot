import { createConsultStore } from './composition.js'
import { runConsultTurn } from './consult.js'

const [directory, discussionId, turnId] = process.argv.slice(2)
if (!directory || !discussionId || !turnId) {
  process.exitCode = 1
}
else {
  const store = createConsultStore(directory)
  await runConsultTurn(store, discussionId, turnId).catch(() => { process.exitCode = 1 })
}
