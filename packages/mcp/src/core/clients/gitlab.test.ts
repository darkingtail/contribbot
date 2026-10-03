import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitLabIdentityVerifier, GITLAB_CREDENTIAL_BINDINGS_ENV } from './gitlab.js'
import type { RepositoryRef } from '../utils/repository-ref.js'

const instance = 'https://code.example:8443/gitlab'
const repository: RepositoryRef = { platform: 'gitlab', instance, path: 'team/subgroup/repo' }
const fakeToken = 'synthetic-gitlab-token'
const binding = { instance, token_env_name: 'FIXTURE_GITLAB_TOKEN' }
const fetchMock = vi.fn<typeof fetch>()
const readToken = vi.fn<(name: string) => string | undefined>()

function verifier(bindings?: unknown) {
  return createGitLabIdentityVerifier({
    bindings: bindings === undefined ? undefined : JSON.stringify(bindings),
    readToken, fetch: fetchMock,
  })
}

function requestHeaders(index = 0): Headers {
  return new Headers(fetchMock.mock.calls[index]?.[1]?.headers)
}

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => Response.json({ path_with_namespace: repository.path }))
  readToken.mockReset().mockReturnValue(fakeToken)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('instance-bound GitLab identity', () => {
  it('normalizes the binding, reads its token once, and performs one credentialled GET', async () => {
    const verify = verifier([{ ...binding, instance: 'https://CODE.EXAMPLE:8443/gitlab/' }])
    expect(await verify(repository)).toEqual(repository)
    expect(readToken).toHaveBeenCalledExactlyOnceWith('FIXTURE_GITLAB_TOKEN')
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://code.example:8443/gitlab/api/v4/projects/team%2Fsubgroup%2Frepo',
      expect.objectContaining({
        method: 'GET', redirect: 'manual', credentials: 'omit', signal: expect.any(AbortSignal),
      }),
    )
    expect(requestHeaders().get('PRIVATE-TOKEN')).toBe(fakeToken)
    expect(requestHeaders().has('Authorization')).toBe(false)
  })

  it.each([
    'https://other.example:8443/gitlab',
    'https://code.example/gitlab',
    'https://code.example:8444/gitlab',
    'https://code.example:8443',
    'https://code.example:8443/gitlab-staging',
    'https://code.example:8443/gitlab/nested',
    'https://code.example:8443/GitLab',
    'http://code.example:8443/gitlab',
  ])('does not read or forward a token to the non-matching instance %s', async target => {
    const verify = verifier([binding])
    await verify({ ...repository, instance: target })
    expect(readToken).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(requestHeaders().has('PRIVATE-TOKEN')).toBe(false)
  })

  it.each([undefined, []])('uses a single anonymous GET with no binding (%s)', async bindings => {
    await verifier(bindings)(repository)
    expect(readToken).not.toHaveBeenCalled()
    expect(requestHeaders().has('PRIVATE-TOKEN')).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    'https://gitlab.com',
    'https://192.0.2.1:8443/gitlab',
    'http://192.0.2.1:8080/gitlab',
  ])('retains the exact public or IPv4 API base %s', async target => {
    await verifier()({ ...repository, instance: target })
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${target}/api/v4/projects/team%2Fsubgroup%2Frepo`)
    expect(readToken).not.toHaveBeenCalled()
  })

  it('normalizes a default HTTPS port and public service root for credential matching', async () => {
    await verifier([{ ...binding, instance: 'https://GITLAB.COM:443/' }])({
      ...repository, instance: 'https://gitlab.com',
    })
    expect(readToken).toHaveBeenCalledExactlyOnceWith(binding.token_env_name)
  })

  it.each([undefined, '', ' ', 'bad\r\nheader'])('fails closed before fetch for a missing or invalid bound token (%s)', async token => {
    readToken.mockReturnValue(token)
    await expect(verifier([binding])(repository)).rejects.toThrow(/credentials unavailable/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(readToken).toHaveBeenCalledExactlyOnceWith(binding.token_env_name)
  })

  it('does not echo errors from the token source or fall back to anonymous auth', async () => {
    readToken.mockImplementation(() => { throw new Error(fakeToken) })
    const result = await verifier([binding])(repository).catch(error => error as Error)
    expect(result).toBeInstanceOf(Error)
    expect(String(result)).not.toContain(fakeToken)
    expect(result).not.toHaveProperty('cause')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('supports token rotation without altering the instance binding', async () => {
    const verify = verifier([binding])
    await verify(repository)
    readToken.mockReturnValue('synthetic-rotated-token')
    await verify(repository)
    expect(requestHeaders(0).get('PRIVATE-TOKEN')).toBe(fakeToken)
    expect(requestHeaders(1).get('PRIVATE-TOKEN')).toBe('synthetic-rotated-token')
    expect(readToken.mock.calls).toEqual([[binding.token_env_name], [binding.token_env_name]])
  })

  it.each([
    null, {}, ['invalid'], [{ instance }], [{ ...binding, token: fakeToken }],
    [{ ...binding, token_env_name: 'INVALID-TOKEN' }],
    [{ ...binding, token_env_name: 'TOKEN\n' }],
    [{ ...binding, instance: 'http://code.example/gitlab' }],
    [{ ...binding, instance: 'https://user:fixture-secret@code.example' }],
    [{ ...binding, instance: 'https://code.example/gitlab?token=fixture-secret' }],
    [{ ...binding, instance: 'https://github.com' }],
    [binding, { ...binding, instance: 'https://CODE.EXAMPLE:8443/gitlab/' }],
    [binding, { ...binding, instance: 'https://other.example/gitlab' }],
    [binding, { ...binding, instance: 'https://other.example/gitlab', token_env_name: 'fixture_gitlab_token' }],
  ])('rejects invalid metadata without reading a token or requesting a project (%j)', async bindings => {
    const verify = verifier(bindings)
    await expect(verify(repository)).rejects.toThrow(/^GitLab credential bindings are invalid/)
    expect(readToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not validate malformed JSON at factory creation or echo it on use', async () => {
    const verify = createGitLabIdentityVerifier({ bindings: fakeToken, readToken, fetch: fetchMock })
    const result = await verify(repository).catch(error => error as Error)
    expect(String(result)).toContain('bindings are invalid')
    expect(String(result)).not.toContain(fakeToken)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects the wrong platform and noncanonical request before any credentials are read', async () => {
    const verify = verifier([binding])
    await expect(verify({ ...repository, platform: 'github', path: 'owner/repo' })).rejects.toThrow(/only supports GitLab/)
    await expect(verify({ ...repository, instance: `${instance}/` })).rejects.toThrow()
    expect(readToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('identity responses and redacted failures', () => {
  it.each([301, 302, 303, 307, 308, 401, 403, 404, 429, 500, 204])('refuses HTTP %s without reading its body or retrying', async status => {
    const response = new Response(status === 204 ? null : fakeToken, {
      status, headers: { Location: 'https://other.example/gitlab' },
    })
    const readBody = vi.spyOn(response, 'text')
    const readJson = vi.spyOn(response, 'json')
    fetchMock.mockResolvedValueOnce(response)
    const result = await verifier([binding])(repository).catch(error => error as Error)
    expect(String(result)).toContain(`HTTP ${status}`)
    expect(String(result)).not.toContain(fakeToken)
    expect(result).not.toHaveProperty('cause')
    expect(readBody).not.toHaveBeenCalled()
    expect(readJson).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('also refuses a same-instance redirect without forwarding credentials a second time', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, {
      status: 302, headers: { Location: `${instance}/new-project` },
    }))
    await expect(verifier([binding])(repository)).rejects.toThrow(/HTTP 302/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses an already-followed response even if its final status and path match', async () => {
    const response = Response.json({ path_with_namespace: repository.path })
    Object.defineProperty(response, 'redirected', { value: true })
    fetchMock.mockResolvedValueOnce(response)
    await expect(verifier([binding])(repository)).rejects.toThrow(/redirect refused/)
  })

  it('redacts a rejected fetch, including its cause', async () => {
    fetchMock.mockRejectedValueOnce(new Error(`network ${fakeToken}`, { cause: new Error(fakeToken) }))
    const result = await verifier([binding])(repository).catch(error => error as Error)
    expect(String(result)).toContain('network error')
    expect(String(result)).not.toContain(fakeToken)
    expect(result).not.toHaveProperty('cause')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('redacts invalid JSON without inspecting a text body', async () => {
    const response = new Response(fakeToken)
    const text = vi.spyOn(response, 'text')
    fetchMock.mockResolvedValueOnce(response)
    const result = await verifier()(repository).catch(error => error as Error)
    expect(String(result)).toContain('invalid JSON')
    expect(String(result)).not.toContain(fakeToken)
    expect(text).not.toHaveBeenCalled()
  })

  it.each([
    null, [], {}, { path_with_namespace: 1 },
    { path_with_namespace: 'Team/subgroup/repo' },
    { path_with_namespace: 'team/other/repo' },
  ])('rejects a nonexact identity %j', async metadata => {
    fetchMock.mockResolvedValueOnce(Response.json(metadata))
    await expect(verifier()(repository)).rejects.toThrow(/identity mismatch/)
  })
})

describe('default startup snapshot', () => {
  it('keeps binding metadata immutable while token values rotate and ignores generic token vars', async () => {
    vi.stubEnv(GITLAB_CREDENTIAL_BINDINGS_ENV, JSON.stringify([binding]))
    vi.stubEnv(binding.token_env_name, fakeToken)
    vi.stubEnv('GITLAB_TOKEN', 'synthetic-generic-token')
    vi.stubEnv('GLAB_TOKEN', 'synthetic-glab-token')
    vi.stubEnv('CI_JOB_TOKEN', 'synthetic-job-token')
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()
    const { verifyGitLabIdentity } = await import('./gitlab.js')
    vi.stubEnv(GITLAB_CREDENTIAL_BINDINGS_ENV, 'invalid-later-metadata')
    await verifyGitLabIdentity(repository)
    vi.stubEnv(binding.token_env_name, 'synthetic-rotated-token')
    await verifyGitLabIdentity(repository)
    await verifyGitLabIdentity({ ...repository, instance: 'https://other.example/gitlab' })
    expect(requestHeaders(0).get('PRIVATE-TOKEN')).toBe(fakeToken)
    expect(requestHeaders(1).get('PRIVATE-TOKEN')).toBe('synthetic-rotated-token')
    expect(requestHeaders(2).has('PRIVATE-TOKEN')).toBe(false)
  })

  it('defers malformed startup metadata until GitLab verification and cannot dynamically rebind', async () => {
    vi.stubEnv(GITLAB_CREDENTIAL_BINDINGS_ENV, 'synthetic-invalid')
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()
    const { verifyGitLabIdentity } = await import('./gitlab.js')
    vi.stubEnv(GITLAB_CREDENTIAL_BINDINGS_ENV, '[]')
    await expect(verifyGitLabIdentity(repository)).rejects.toThrow(/bindings are invalid/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
