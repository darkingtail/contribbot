import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { assertNoSymlinks } from '../storage/paths.js'
import { loadRepoConfig, type RepoConfigData } from './config.js'
import { projectDataRoot, repositoryIdentityKey, type RepositoryRef } from './ref.js'

export const PROJECT_PROBLEM_CODES = [
  'config_missing',
  'config_invalid',
  'todo_data_unreadable',
  'upstream_data_unreadable',
  'duplicate_repository_identity',
] as const

export type ProjectProblemCode = typeof PROJECT_PROBLEM_CODES[number]

export interface ProjectProblem {
  code: ProjectProblemCode
  directory: string
  repository?: RepositoryRef
  message: string
}

export interface StoredProject {
  directory: string
  config: RepoConfigData
}

export interface ProjectScanResult {
  projects: StoredProject[]
  problems: ProjectProblem[]
}

function projectDirectories(root?: string): string[] | null {
  const projectsRoot = join(projectDataRoot(root), 'projects', 'v1')
  assertNoSymlinks(projectsRoot)
  const rootStat = lstatSync(projectsRoot, { throwIfNoEntry: false })
  if (!rootStat) return null
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Invalid schema v3 projects directory: ${projectsRoot}`)
  }

  const directories: string[] = []
  for (const entry of readdirSync(projectsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = join(projectsRoot, entry.name)
    if (!/^[a-f0-9]{64}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Invalid schema v3 project directory: ${directory}`)
    }
    directories.push(directory)
  }
  return directories
}

/** Strict loading for repository-scoped lookups; no partial result on damaged siblings. */
export function listStoredProjects(root?: string): StoredProject[] | null {
  const directories = projectDirectories(root)
  if (!directories) return null
  const projects: StoredProject[] = []
  const seen = new Set<string>()
  for (const directory of directories) {
    const config = loadRepoConfig(directory)
    if (!config) throw new Error(`Missing schema v3 repository config: ${directory}`)
    const key = repositoryIdentityKey(config.repository)
    if (seen.has(key)) throw new Error(`Duplicate schema v3 project identity: ${directory}`)
    seen.add(key)
    projects.push({ directory, config })
  }
  return projects
}

/** Batch discovery retains healthy projects while explicitly reporting config failures. */
export function scanStoredProjects(root?: string): ProjectScanResult {
  const directories = projectDirectories(root)
  if (!directories) return { projects: [], problems: [] }
  const projects: StoredProject[] = []
  const problems: ProjectProblem[] = []
  const seen = new Map<string, string>()
  for (const directory of directories) {
    let config: RepoConfigData | null
    try {
      config = loadRepoConfig(directory)
    }
    catch (error) {
      problems.push({
        code: 'config_invalid', directory,
        message: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    if (!config) {
      problems.push({
        code: 'config_missing', directory,
        message: `Missing schema v3 repository config: ${directory}`,
      })
      continue
    }
    const key = repositoryIdentityKey(config.repository)
    const previous = seen.get(key)
    if (previous) {
      problems.push({
        code: 'duplicate_repository_identity', directory, repository: config.repository,
        message: `Repository identity is already listed from ${previous}.`,
      })
      continue
    }
    seen.set(key, directory)
    projects.push({ directory, config })
  }
  return { projects, problems }
}
