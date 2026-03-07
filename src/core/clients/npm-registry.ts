import { ofetch } from 'ofetch'

const REGISTRY_URL = 'https://registry.npmjs.org'

interface NpmPackageInfo {
  name: string
  'dist-tags': Record<string, string>
  versions: Record<string, unknown>
}

export async function getPackageInfo(name: string): Promise<NpmPackageInfo> {
  return ofetch<NpmPackageInfo>(`${REGISTRY_URL}/${encodeURIComponent(name)}`, {
    headers: { Accept: 'application/json' },
    timeout: 15_000,
  })
}

export async function getLatestVersion(name: string): Promise<string | null> {
  try {
    const info = await getPackageInfo(name)
    return info['dist-tags'].latest ?? null
  }
  catch {
    return null
  }
}

export async function getBatchLatestVersions(
  names: string[],
): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>()
  // Batch in groups of 5 to avoid rate limiting
  const batchSize = 5
  for (let i = 0; i < names.length; i += batchSize) {
    const batch = names.slice(i, i + batchSize)
    const promises = batch.map(async (name) => {
      const version = await getLatestVersion(name)
      results.set(name, version)
    })
    await Promise.all(promises)
  }
  return results
}
