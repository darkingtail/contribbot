import { withTodoLock } from '../../../storage/todo-lock.js'
import { TodoStore } from '../../../storage/todo-store.js'

const directory = process.argv[2]!
try {
  withTodoLock(directory, () => new TodoStore(directory).delete(0, { force: true }), 150)
  console.log(JSON.stringify({ outcome: 'deleted' }))
}
catch (error) {
  if (!(error instanceof Error) || !error.message.startsWith('Timed out waiting for Todo transaction.')) throw error
  console.log(JSON.stringify({ outcome: 'blocked' }))
}
