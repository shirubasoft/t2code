/**
 * Downstream privacy policy for the telemetry-free distribution.
 *
 * Keep this as a compile-time constant so telemetry integrations can retain
 * their upstream-compatible interfaces without ever starting collectors or
 * exporters in a shipped build.
 */
export const TELEMETRY_ENABLED: boolean = false;
