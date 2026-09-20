import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, unlinkSync, writeFileSync,
} from 'node:fs'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'

const sha256 = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex')
type ReceiptNamespace = 'result' | 'process' | 'supervisor' | 'reconciliation' | 'closure-reconciliation' | 'report-intent' | 'control'

/** Immutable local blobs and operation-to-receipt pointers. No live state is kept here. */
export class ExecutionArtifacts {
  private readonly base: string
  private readonly executionId: string

  constructor(directory: string, executionId: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(executionId)) throw new Error('Unsafe execution artifact id.')
    mkdirSync(directory, { recursive: true })
    this.base = realpathSync(directory)
    this.executionId = executionId
    this.directory('artifacts')
    this.directory('receipts')
  }

  private directory(kind: 'artifacts' | 'receipts'): string {
    let path = this.base
    for (const component of ['executions', this.executionId, kind]) {
      path = join(path, component)
      if (!existsSync(path)) mkdirSync(path)
      if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) {
        throw new Error('Artifact directory must not be a link or non-directory.')
      }
    }
    return path
  }

  private read(path: string): Buffer {
    if (lstatSync(path).isSymbolicLink()) throw new Error('Artifact must not be a symbolic link.')
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('Artifact is not a bounded regular file.')
      return readFileSync(fd)
    }
    finally { closeSync(fd) }
  }

  private publish(path: string, content: string): void {
    if (Buffer.byteLength(content) > 32 * 1024 * 1024) throw new Error('Artifact size limit exceeded.')
    const temporary = `${path}.${randomUUID()}.pending`
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(fd, content, 'utf8')
      fsyncSync(fd)
    }
    finally { closeSync(fd) }
    try {
      // Link publication is atomic and, unlike rename, cannot replace an existing receipt.
      try { linkSync(temporary, path) }
      catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
        if (!this.read(path).equals(Buffer.from(content))) throw new Error('Immutable artifact already exists with different content.')
      }
    }
    finally { unlinkSync(temporary) }
  }

  put(value: unknown): string {
    const content = JSON.stringify(value)
    if (content === undefined) throw new Error('Artifact must contain JSON.')
    const digest = sha256(content)
    this.publish(join(this.directory('artifacts'), `${digest}.json`), content)
    return digest
  }

  get(digest: string): unknown {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid artifact digest.')
    const content = this.read(join(this.directory('artifacts'), `${digest}.json`))
    if (sha256(content) !== digest) throw new Error('Artifact content digest mismatch.')
    return JSON.parse(content.toString('utf8')) as unknown
  }

  private receiptPath(operationId: string, namespace: ReceiptNamespace): string {
    const prefix = namespace === 'result' ? '' : `${namespace}-`
    return join(this.directory('receipts'), `${prefix}${sha256(operationId)}.json`)
  }

  putReceipt(operationId: string, value: unknown, namespace: ReceiptNamespace = 'result'): string {
    const artifact = this.put(value)
    const pointer = { version: 1, operation_id: operationId, artifact }
    this.publish(this.receiptPath(operationId, namespace), JSON.stringify(pointer))
    return artifact
  }

  /** Used while commands are running, so filesystem latency cannot block their supervision. */
  async putReceiptAsync(operationId: string, value: unknown, namespace: ReceiptNamespace = 'result'): Promise<string> {
    const content = JSON.stringify(value)
    if (content === undefined) throw new Error('Artifact must contain JSON.')
    const artifact = sha256(content)
    const directory = async (kind: 'artifacts' | 'receipts') => {
      let path = this.base
      for (const component of ['executions', this.executionId, kind]) {
        path = join(path, component)
        try { await fs.mkdir(path) }
        catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
        }
        const stat = await fs.lstat(path)
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Artifact directory must not be a link or non-directory.')
      }
      return path
    }
    const publish = async (path: string, value: string) => {
      if (Buffer.byteLength(value) > 32 * 1024 * 1024) throw new Error('Artifact size limit exceeded.')
      const temporary = `${path}.${randomUUID()}.pending`
      const fd = await fs.open(temporary, 'wx', 0o600)
      try {
        try { await fd.writeFile(value, 'utf8'); await fd.sync() }
        finally { await fd.close() }
        try { await fs.link(temporary, path) }
        catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
          if ((await fs.lstat(path)).isSymbolicLink()) throw new Error('Artifact must not be a symbolic link.')
          const existing = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
          try {
            const stat = await existing.stat()
            if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('Artifact is not a bounded regular file.')
            if (!(await existing.readFile()).equals(Buffer.from(value))) throw new Error('Immutable artifact already exists with different content.')
          }
          finally { await existing.close() }
        }
      }
      finally { await fs.unlink(temporary) }
    }
    await publish(join(await directory('artifacts'), `${artifact}.json`), content)
    const prefix = namespace === 'result' ? '' : `${namespace}-`
    await publish(join(await directory('receipts'), `${prefix}${sha256(operationId)}.json`),
      JSON.stringify({ version: 1, operation_id: operationId, artifact }))
    return artifact
  }

  getReceipt(operationId: string, namespace: ReceiptNamespace = 'result'): { digest: string; value: unknown } | undefined {
    const path = this.receiptPath(operationId, namespace)
    if (!existsSync(path)) return undefined
    const pointer = JSON.parse(this.read(path).toString('utf8')) as { version: number; operation_id: string; artifact: string }
    if (pointer.version !== 1 || pointer.operation_id !== operationId || typeof pointer.artifact !== 'string') {
      throw new Error('Invalid operation receipt pointer.')
    }
    return { digest: pointer.artifact, value: this.get(pointer.artifact) }
  }
}
