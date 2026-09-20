import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
    // Real Git/process fixtures spawn their own children; avoid oversubscribing the host.
    maxWorkers: 2,
  },
})
