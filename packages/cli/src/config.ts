/** Build-time configuration defaults, adjustable per release without touching call sites. */
export const buildConfig = {
  /** Suppress upstream `skills` telemetry on spawned children via its own opt-out env var. */
  suppressUpstreamTelemetry: true,
} as const
