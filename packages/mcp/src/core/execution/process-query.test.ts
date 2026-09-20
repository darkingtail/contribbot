import { execFile, execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeProcess, describeProcessAsync, observeProcess } from './processes.js'

vi.mock('node:child_process', () => ({ execFile: vi.fn(), execFileSync: vi.fn() }))

describe('bounded OS process identity queries', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const timestamp = '2026-09-19T09:00:00.1234567Z'
  const missing = Object.assign(new Error('Executable unavailable'), { code: 'ENOENT' })
  const sync = vi.mocked(execFileSync)
  const asyncQuery = vi.mocked(execFile)
  const setPlatform = (value: string) => Object.defineProperty(process, 'platform', { ...platform, value })

  function asyncResults(...results: (string | Error)[]) {
    for (const result of results) {
      asyncQuery.mockImplementationOnce((...args: unknown[]) => {
        const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void
        queueMicrotask(() => callback(result instanceof Error ? result : null,
          typeof result === 'string' ? result : '', ''))
        return {} as ReturnType<typeof execFile>
      })
    }
  }

  beforeEach(() => {
    setPlatform('win32')
    vi.clearAllMocks()
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
    vi.restoreAllMocks()
    sync.mockReset()
    asyncQuery.mockReset()
  })

  it('prefers PowerShell 7 without caching identity observations', () => {
    sync.mockReturnValue(timestamp)
    const handle = describeProcess(process.pid)
    expect(handle.started_at).toBe(Date.parse(timestamp))
    expect(observeProcess(handle).state).toBe('running')
    expect(sync).toHaveBeenCalledTimes(2)
    for (const [file, args, options] of sync.mock.calls) {
      expect(file).toBe('pwsh.exe')
      expect(args).toContain('-NoProfile')
      expect(args!.at(-1)).toContain('InvariantCulture')
      expect(options).toMatchObject({ windowsHide: true, maxBuffer: 4096,
        env: expect.objectContaining({ CONTRIBBOT_PROCESS_ID: String(process.pid) }) })
      expect((options as { timeout: number }).timeout).toBeLessThanOrEqual(3000)
    }
  })

  it.each(['sync', 'async'] as const)('falls back only for a missing executable in the %s query', async mode => {
    if (mode === 'sync') sync.mockImplementationOnce(() => { throw missing }).mockReturnValueOnce(timestamp)
    else asyncResults(missing, timestamp)
    const handle = mode === 'sync' ? describeProcess(process.pid) : await describeProcessAsync(process.pid)
    expect(handle.started_at).toBe(Date.parse(timestamp))
    const calls = mode === 'sync' ? sync.mock.calls : asyncQuery.mock.calls
    expect(calls.map(call => call[0])).toEqual(['pwsh.exe', 'powershell.exe'])
    expect(calls[0]![1]).toEqual(calls[1]![1])
  })

  it.each(['sync', 'async'] as const)('shares one deadline across missing-runner fallback in the %s query', async mode => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(500)
    if (mode === 'sync') sync.mockImplementationOnce(() => { throw missing }).mockReturnValueOnce(timestamp)
    else asyncResults(missing, timestamp)
    if (mode === 'sync') describeProcess(process.pid)
    else await describeProcessAsync(process.pid)
    const calls = mode === 'sync' ? sync.mock.calls : asyncQuery.mock.calls
    expect(calls.map(call => (call[2] as { timeout: number }).timeout)).toEqual([3000, 2500])
  })

  it.each(['sync', 'async'] as const)('does not start fallback after the %s query deadline', async mode => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(3001)
    if (mode === 'sync') sync.mockImplementationOnce(() => { throw missing })
    else asyncResults(missing)
    const handle = mode === 'sync' ? describeProcess(process.pid) : await describeProcessAsync(process.pid)
    expect(handle.started_at).toBeNull()
    expect(mode === 'sync' ? sync : asyncQuery).toHaveBeenCalledTimes(1)
  })

  it.each(['ETIMEDOUT', 'EACCES', 'ENOEXEC', 1])('keeps failure %s unknown without another interpreter', async code => {
    const error = Object.assign(new Error('Query failed'), { code })
    sync.mockImplementation(() => { throw error })
    asyncResults(error)
    const handle = describeProcess(process.pid)
    expect(handle.started_at).toBeNull()
    expect(observeProcess(handle).state).toBe('unknown')
    expect((await describeProcessAsync(process.pid)).started_at).toBeNull()
    expect(sync.mock.calls.map(call => call[0])).toEqual(['pwsh.exe', 'pwsh.exe'])
    expect(asyncQuery.mock.calls.map(call => call[0])).toEqual(['pwsh.exe'])
  })

  it.each(['', 'not a date'])('keeps malformed output %j unknown without fallback', async output => {
    sync.mockReturnValue(output)
    asyncResults(output)
    const handle = describeProcess(process.pid)
    expect(handle.started_at).toBeNull()
    expect(observeProcess(handle).state).toBe('unknown')
    expect((await describeProcessAsync(process.pid)).started_at).toBeNull()
    expect(sync.mock.calls.every(call => call[0] === 'pwsh.exe')).toBe(true)
    expect(asyncQuery).toHaveBeenCalledTimes(1)
  })

  it('retains unknown when neither Windows interpreter is available', async () => {
    sync.mockImplementation(() => { throw missing })
    asyncResults(missing, missing)
    expect(describeProcess(process.pid).started_at).toBeNull()
    expect((await describeProcessAsync(process.pid)).started_at).toBeNull()
    expect(sync).toHaveBeenCalledTimes(2)
    expect(asyncQuery).toHaveBeenCalledTimes(2)
  })

  it.each(['linux', 'darwin'])('keeps the %s ps query and C locale', async platform => {
    setPlatform(platform)
    sync.mockReturnValue(timestamp)
    asyncResults(timestamp)
    expect(describeProcess(process.pid).started_at).toBe(Date.parse(timestamp))
    expect((await describeProcessAsync(process.pid)).started_at).toBe(Date.parse(timestamp))
    for (const [file, args, options] of [...sync.mock.calls, ...asyncQuery.mock.calls]) {
      expect(file).toBe('ps')
      expect(args).toEqual(['-p', String(process.pid), '-o', 'lstart='])
      expect(options).toMatchObject({ env: expect.objectContaining({ LC_ALL: 'C' }) })
    }
  })
})
