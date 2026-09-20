import { TodoStore } from '../todo-store.js'

const [directory, label, countText] = process.argv.slice(2)
if (!directory || !label || !countText) throw new Error('Expected directory, label and count.')
const store = new TodoStore(directory)
const originalList = store.list.bind(store)
store.list = () => {
  const snapshot = originalList()
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  return snapshot
}
for (let index = 0; index < Number(countText); index++) {
  store.add({ ref: `${label}-${index}`, title: `${label} ${index}`, type: 'chore' })
}
