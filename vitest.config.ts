import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { defineConfig } from 'vitest/config'

const serviceUrl = process.env.VITE_RPA_SERVICE_URL || parseEnv(readFileSync(resolve('.dev'), 'utf8')).VITE_RPA_SERVICE_URL

export default defineConfig({
  define: { 'import.meta.env.VITE_RPA_SERVICE_URL': JSON.stringify(serviceUrl) },
  resolve: {
    alias: {
      '@graph': resolve('src/graph'),
      '@runner': resolve('src/runner'),
    },
  },
  test: {
    include: ['src/**/*.spec.ts'],
  },
})
