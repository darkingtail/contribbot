import { ConsultStore } from './store.js'

/** Advisory corruption must not prevent unrelated task work or masquerade as task evidence. */
export function todoConsultations(directory: string, todoId: string) {
  try {
    return {
      status: 'available' as const, discussions: new ConsultStore(directory).list(todoId),
      notes: 'Advice only. Read details with consult_read; no task state or acceptance is implied.',
    }
  }
  catch {
    return {
      status: 'unavailable' as const, discussions: [],
      notes: 'Consult records could not be read. Todo execution remains independent; inspect consultation storage separately.',
    }
  }
}

export function formatConsultations(directory: string, todoId: string): string {
  const projection = todoConsultations(directory, todoId)
  if (projection.status === 'unavailable') return `\n\n## Consultations\n\n${projection.notes}`
  if (!projection.discussions.length) return ''
  const lines = [
    '\n\n## Consultations', '', '| Discussion | Purpose | Status | Turns | Note |',
    '| --- | --- | --- | --- | --- |',
    ...projection.discussions.map(item =>
      `| ${item.id} | ${item.purpose} | ${item.status} | ${item.turn_count} | Advisory only; use consult_read |`),
  ]
  return lines.join('\n')
}
