import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const DEFAULT_REPO_OWNER = 'antdv-next'
export const DEFAULT_REPO_NAME = 'antdv-next'
export const UPSTREAM_OWNER = 'ant-design'
export const UPSTREAM_NAME = 'ant-design'

export function getGitHubToken(): string | undefined {
  return process.env.GITHUB_TOKEN
}

export function getProjectRoot(override?: string): string {
  if (override) {
    return resolve(override)
  }

  if (process.env.ANTDV_NEXT_ROOT) {
    return resolve(process.env.ANTDV_NEXT_ROOT)
  }

  // Walk up from cwd to find monorepo root (has pnpm-workspace.yaml)
  let dir = process.cwd()
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir
    }
    dir = dirname(dir)
  }

  return process.cwd()
}

export function getAntdvPackagePath(projectRoot?: string): string {
  return join(getProjectRoot(projectRoot), 'packages', 'antdv-next')
}

export function getComponentsDir(projectRoot?: string): string {
  return join(getAntdvPackagePath(projectRoot), 'src')
}
