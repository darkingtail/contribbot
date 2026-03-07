import { renameSync, writeFileSync } from 'node:fs'

export function safeWriteFileSync(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, filePath)
}
