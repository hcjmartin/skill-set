import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // Percent floors set just below the current baseline so ordinary churn passes but a
      // real regression fails CI. Branches is lowest because it is the strictest metric.
      thresholds: {
        statements: 85,
        branches: 75,
        functions: 90,
        lines: 90,
      },
    },
  },
})
