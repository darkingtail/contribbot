import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describeProcess, describeProcessAsync, localMachine, observeProcess } from './processes.js'
import { describe, expect, it } from 'vitest'

describe('local process observations', () => {
  it('queries OS identity without blocking other process supervision', async () => {
    let responsive = false
    const timer = setTimeout(() => { responsive = true }, 0)
    try {
      const handle = await describeProcessAsync(process.pid)
      expect(responsive).toBe(true)
      expect(handle.started_at).not.toBeNull()
      expect(observeProcess(handle).state).toBe('running')
    }
    finally { clearTimeout(timer) }
  }, 15_000)

  it('observes the current process incarnation', () => {
    const handle = describeProcess(process.pid)
    expect(handle).toMatchObject({ pid: process.pid, machine: localMachine() })
    expect(handle.started_at).not.toBeNull()
    expect(observeProcess(handle).state).toBe('running')
  }, 15_000)

  it('observes an actual child before and after its terminal event', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
    await once(child, 'spawn')
    try {
      const handle = describeProcess(child.pid!)
      expect(observeProcess(handle).state).toBe('running')
      const closed = once(child, 'close')
      child.kill()
      await closed
      expect(observeProcess(handle).state).toBe('stopped')
    }
    finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close')
        child.kill()
        await closed
      }
    }
  }, 15_000)

  it('distinguishes a reused pid from the original process and refuses remote host inference', () => {
    const handle = describeProcess(process.pid)
    expect(observeProcess({ ...handle, started_at: 0 }).state).toBe('replaced')
    expect(observeProcess({ ...handle, machine: { ...handle.machine, hostname: 'other-fixture-host' } }).state).toBe('unknown')
    expect(observeProcess({ ...handle, started_at: null }).state).toBe('unknown')
  }, 15_000)
})
