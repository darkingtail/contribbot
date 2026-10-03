import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, it } from 'vitest'
import { RepoConfig } from '../core/storage/repo-config.js'
import { projectDirectory, type RepositoryRef } from '../core/utils/repository-ref.js'

it.each(['[]', 'invalid synthetic binding metadata'])(
  'starts and reads an offline GitLab project without GitHub auth or eager credential parsing (%s)',
  async bindings => {
    const home = mkdtempSync(join(tmpdir(), 'mcp-startup-'))
    const repository: RepositoryRef = {
      platform: 'gitlab',
      instance: 'https://code.example/gitlab',
      path: 'team/subgroup/repo',
    }
    const directory = projectDirectory(repository, join(home, '.contribbot'))
    new RepoConfig(directory).save({
      schema_version: 3,
      repository,
      lifecycle: { status: 'active' },
      parent: { status: 'unknown' },
      tracking: { status: 'none' },
    })
    const before = readFileSync(join(directory, 'config.yaml'))
    const client = new Client({ name: 'startup-fixture', version: '1' })
    const env: Record<string, string> = {
      HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      XDG_CONFIG_HOME: home, GH_CONFIG_DIR: join(home, 'gh'),
      PATH: join(home, 'no-executables'),
      CONTRIBBOT_GITLAB_CREDENTIAL_BINDINGS: bindings,
    }
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
      if (process.env[key] !== undefined) env[key] = process.env[key]!
    }
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../../../../scripts/dev-mcp.mjs', import.meta.url))],
      cwd: home, env, stderr: 'pipe',
    })
    let stderr = ''
    transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    try {
      await client.connect(transport).catch((error: Error) => {
        throw new Error(`${error.message}; startup stderr: ${stderr}`)
      })
      const listing = await client.listTools()
      expect(listing.tools.some(tool => tool.name === 'project_init')).toBe(true)
      const result = await client.callTool({ name: 'project_init', arguments: { repo: repository } })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      expect(result.structuredContent).toMatchObject({ repository, directory })
      const missingRepo = await client.callTool({ name: 'todo_list', arguments: {} })
      expect(missingRepo.isError).toBe(true)
      expect(readFileSync(join(directory, 'config.yaml'))).toEqual(before)
    }
    finally {
      await client.close()
      await transport.close()
      rmSync(home, { recursive: true, force: true })
    }
  }, 20_000,
)
