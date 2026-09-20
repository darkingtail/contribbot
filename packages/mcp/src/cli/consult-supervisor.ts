import { runConsultTurn } from '../core/consult/runner.js'

const [directory, discussionId, turnId] = process.argv.slice(2)
if (!directory || !discussionId || !turnId) {
  process.exitCode = 1
}
else {
  await runConsultTurn(directory, discussionId, turnId).catch(() => { process.exitCode = 1 })
}
