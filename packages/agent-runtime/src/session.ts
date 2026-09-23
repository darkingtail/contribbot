import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executableDigest } from './binding.js'
import type { ProviderBindingDescriptor } from './binding.js'
import { advisorEnvironment } from './environment.js'
import { nativeBindings } from './providers.js'
import { probeCodexReadonly } from './sandbox.js'
import { pipeTransport } from './transport.js'
import type { RuntimeOutcome, TurnControl } from './transport.js'

export interface CapabilityEvidence {
  verified: boolean
  reason: string
  digest: string
}

export interface ProviderPreparation {
  directory: string | null
  capability: CapabilityEvidence | null
  cleanup?: () => void
}

export type PreparedProviderRun = {
  status: 'blocked'
  preparations: ProviderPreparation[]
  reason: string
} | {
  status: 'ready'
  preparations: ProviderPreparation[]
  run(input: string, control: TurnControl): Promise<RuntimeOutcome>
}

export async function verifyProviderBinding(binding: Pick<ProviderBindingDescriptor, 'executable' | 'executable_digest'>): Promise<void> {
  if (await executableDigest(binding.executable) !== binding.executable_digest) {
    throw new Error('Advisor executable changed after authorization. Obtain a new preview.')
  }
}

/** Prepare one native invocation without domain state or model dispatch. */
export async function prepareProviderRun(binding: ProviderBindingDescriptor): Promise<PreparedProviderRun> {
  let capability: CapabilityEvidence | null = null
  const preparations: ProviderPreparation[] = []
  if (binding.runtime === 'codex') {
    const observed = await probeCodexReadonly(binding)
    capability = { verified: observed.verified, reason: observed.reason, digest: observed.digest }
    preparations.push({ directory: null, capability })
    if (!capability.verified) {
      return {
        status: 'blocked', preparations,
        reason: `Advisor unavailable: ${capability.reason} Probe digest: ${capability.digest}. No model call was made.`,
      }
    }
  }
  const protocol = nativeBindings[binding.runtime]
  const argv = protocol.argv({ model: binding.model })
  const env = advisorEnvironment(binding.runtime)
  const directory = mkdtempSync(join(tmpdir(), 'contribbot-advisor-'))
  preparations.push({
    directory, capability,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  })
  return {
    status: 'ready', preparations,
    run: (input, control) => pipeTransport.run({
      executable: binding.executable, argv, cwd: directory, env,
    }, input, protocol, control),
  }
}
