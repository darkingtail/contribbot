import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/mcp/index.ts',
  ],
  format: 'esm',
  dts: true,
  clean: true,
  skipNodeModulesBundle: true,
  outExtensions() {
    return {
      js: '.js',
      dts: '.d.ts',
    }
  },
  banner: {
    js: '#!/usr/bin/env node',
  },
})
