import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.mjs'],
    environment: 'node',
    globals: false,
    testTimeout: 10000,
  },
})
