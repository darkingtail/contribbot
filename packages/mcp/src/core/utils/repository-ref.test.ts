import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  normalizeRepositoryRef,
  parseRepositoryInput,
  projectDirectory,
  repositoryDigest,
  repositoryIdentityKey,
  type RepositoryRef,
} from './repository-ref.js'

const identityVectors = JSON.parse(readFileSync(
  new URL('./__fixtures__/repository-key-v1.json', import.meta.url), 'utf8',
)) as { canonical: Array<{ input: RepositoryRef, expected: RepositoryRef }>, invalid: RepositoryRef[] }

describe('repository identity', () => {
  const github: RepositoryRef = {
    platform: 'github',
    instance: 'https://github.com',
    path: 'darkingtail/contribbot',
  }

  it('accepts a complete repository object without losing its platform and instance', () => {
    expect(parseRepositoryInput(github)).toEqual(github)
  })

  it.each([
    'darkingtail/contribbot',
    'https://github.com/darkingtail/contribbot',
    ['github', 'https://github.com', 'darkingtail/contribbot'],
    undefined,
    null,
  ])('rejects non-object repository input: %s', input => {
    expect(() => parseRepositoryInput(input)).toThrow(/object with exactly platform, instance, and path/i)
  })

  it.each([
    'https://code.example.com/gitlab/../other',
    'https://code.example.com/gitlab/./other',
    'https://code.example.com/gitlab//other',
    'https://code.example.com/gitlab/%2e%2e/other',
    'https://code.example.com/gitlab\\other',
  ])('rejects unsafe raw instance path before URL normalization: %s', instance => {
    expect(() => parseRepositoryInput({ platform: 'gitlab', instance, path: 'team/repo' })).toThrow()
  })

  it.each([
    { platform: 'github', instance: 'https://github.com/owner' },
    { platform: 'gitlab', instance: 'https://gitlab.com/group' },
    { platform: 'github', instance: 'https://gitlab.com' },
    { platform: 'gitlab', instance: 'https://github.com' },
    { platform: 'github', instance: 'http://github.com' },
    { platform: 'gitlab', instance: 'https://gitlab.com:8443' },
  ] as const)('rejects a public service URL that is not its instance root: $platform $instance', value => {
    expect(() => parseRepositoryInput({ ...value, path: 'team/repo' })).toThrow(/instance/i)
  })

  it('preserves an installation path on a self-hosted instance', () => {
    const repository: RepositoryRef = {
      platform: 'gitlab',
      instance: 'https://code.example.com:8443/gitlab',
      path: 'team/subgroup/repo',
    }
    expect(parseRepositoryInput(repository)).toEqual(repository)
  })

  it.each([
    'https://github.com/owner/../repo',
    'https://github.com/owner/%2e%2e/repo',
    'https://git\nhub.com/owner/repo',
    'https://github.com/owner/\trepo',
    'https://github.com/owner/repo?token=secret',
    'https://github.com/owner/repo#fragment',
  ])('rejects unsafe public repository URLs: %s', url => {
    expect(() => parseRepositoryInput(url)).toThrow()
  })

  it('rejects unknown fields on repository objects', () => {
    expect(() => parseRepositoryInput({ ...github, token: 'secret' })).toThrow()
  })

  it('separates the same path across platforms and instances', () => {
    const privateGitlab: RepositoryRef = {
      platform: 'gitlab',
      instance: 'https://code.example.com/gitlab',
      path: 'darkingtail/contribbot',
    }
    expect(repositoryDigest(github)).not.toBe(repositoryDigest(privateGitlab))
    expect(projectDirectory(github)).not.toBe(projectDirectory(privateGitlab))
  })

  it.each(identityVectors.canonical)('normalizes and hashes repository-key-v1: $input.instance', ({ input, expected }) => {
    expect(normalizeRepositoryRef(input)).toEqual(expected)
    const key = JSON.stringify(['repository-key-v1', expected.platform, expected.instance, expected.path])
    expect(repositoryIdentityKey(input)).toBe(key)
    expect(repositoryDigest(input)).toBe(createHash('sha256').update(key, 'utf8').digest('hex'))
    expect(parseRepositoryInput(expected)).toEqual(expected)
  })

  it.each(identityVectors.invalid)('rejects unsafe or ambiguous identity: $instance $path', input => {
    expect(() => normalizeRepositoryRef(input)).toThrow()
  })
})
