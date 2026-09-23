// MCP is loaded by its absolute source entry; it has no self-import source export.
const packages = ['contribbot-core', 'contribbot-platform', 'contribbot-agent-runtime', 'contribbot-runner']

export async function resolve(specifier, context, nextResolve) {
  if (!packages.some(name => specifier === name || specifier.startsWith(`${name}/`))) {
    return nextResolve(specifier, context)
  }
  const resolved = await nextResolve(specifier, {
    ...context,
    conditions: [...new Set([...context.conditions, 'contribbot-source'])],
  })
  if (!new URL(resolved.url).pathname.endsWith('.ts')) {
    throw new Error(`Development import ${specifier} did not resolve to source. Check its contribbot-source export; no dist fallback was executed.`)
  }
  return resolved
}
