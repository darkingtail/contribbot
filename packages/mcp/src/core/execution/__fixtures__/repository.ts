import { RepoConfig } from '../../storage/repo-config.js'
import { projectDirectory } from '../../utils/repository-ref.js'

export function fixtureRepository(path: string) {
  return { platform: 'github' as const, instance: 'https://github.com', path }
}

export function fixtureProjectDirectory(dataRoot: string | undefined, path: string): string {
  return projectDirectory(fixtureRepository(path), dataRoot)
}

export function saveFixtureProjectConfig(directory: string, path: string): void {
  new RepoConfig(directory).save({
    schema_version: 3,
    repository: fixtureRepository(path),
    lifecycle: { status: 'active' },
    parent: { status: 'unknown' },
    tracking: { status: 'pending' },
  })
}
