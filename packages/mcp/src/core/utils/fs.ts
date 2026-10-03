import { closeSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
export { assertNoSymlinks } from 'contribbot-core/storage/paths'

export function safeWriteFileSync(filePath: string, content: string): void {
  const temporary = `${filePath}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    try { writeFileSync(fd, content, 'utf8') }
    finally { closeSync(fd) }
    renameSync(temporary, filePath)
  }
  catch (error) {
    try { unlinkSync(temporary) }
    catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AggregateError([error, cleanupError], `Failed to write and clean up ${filePath}`)
      }
    }
    throw error
  }
}
