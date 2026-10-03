import { lstatSync } from 'node:fs'
import { join, parse, resolve } from 'node:path'

export function assertNoSymlinks(path: string): void {
  const absolute = resolve(path)
  let current = parse(absolute).root
  for (const part of absolute.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Path contains a symbolic link: ${current}`)
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
