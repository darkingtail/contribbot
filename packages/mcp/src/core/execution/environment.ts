import { release } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { Candidate } from './candidate.js'
import { scopePathSchema } from './contracts.js'

const dependencyObservationSchema = z.object({
  path: scopePathSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict()

export const checkEnvironmentSchema = z.object({
  platform: z.string().min(1), node: z.string().min(1), arch: z.string().min(1),
  os_release: z.string().min(1), runner_executable: z.string().min(1),
  dependency_inputs: z.object({
    before: z.array(dependencyObservationSchema).max(256).nullable(),
    after: z.array(dependencyObservationSchema).max(256).nullable(),
  }).strict(),
}).strict()

type DeclaredInputs = { dependency_inputs?: string[] }
export type CheckEnvironment = z.infer<typeof checkEnvironmentSchema>

export function captureRunnerEnvironment(): CheckEnvironment {
  return {
    platform: process.platform, node: process.version, arch: process.arch,
    os_release: release(), runner_executable: process.execPath,
    dependency_inputs: { before: null, after: null },
  }
}

/** Use the original candidate, never read dependency contents or ambient configuration again. */
export function observeDependencyInputs(command: DeclaredInputs, candidate: Candidate) {
  const files = new Map(candidate.files.map(file => [file.path, file.digest]))
  return (command.dependency_inputs ?? []).map(path => ({ path, digest: files.get(path) ?? null }))
}

export function assertDependencyInputs(command: DeclaredInputs, candidate: Candidate): void {
  for (const input of observeDependencyInputs(command, candidate)) {
    if (input.digest === null) {
      throw new Error(`Declared dependency input ${JSON.stringify(input.path)} is missing or not covered by the candidate. Check the file and confirmed plan; no command was started.`)
    }
  }
}

export function verifyDependencyObservation(
  command: DeclaredInputs, candidate: Candidate | null,
  observed: CheckEnvironment['dependency_inputs']['before'],
): void {
  const expected = candidate ? observeDependencyInputs(command, candidate) : null
  if (!isDeepStrictEqual(expected, observed)) {
    throw new Error('Dependency observation does not match the declared inputs and original candidate manifest.')
  }
}

export function environmentLimitations(version: 1 | 2): string[] {
  return [
    version === 1
      ? 'Historical v1 receipt records only runner platform and Node version; dependency inputs were not observed and are not reconstructed.'
      : 'Environment metadata describes the check supervisor, not the version or resolved identity of an arbitrary child executable.',
    'Declared file hashes do not attest installed dependencies, module resolution, environment variables, external services, or the current environment.',
    'The runner does not add a shell; an explicitly selected interpreter or package manager may launch its own shell and child processes.',
  ]
}
