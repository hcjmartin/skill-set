import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Keeps the suite off the developer's real trust store; trust tests point this at their own temp dirs.
    env: { SKILL_SET_CONFIG_DIR: join(tmpdir(), 'skill-set-test-no-config') },
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
