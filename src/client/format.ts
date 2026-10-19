/** Exact millisecond/minute conversions used by the policy form. */
export function cooldownMinutes(ms: number): number {
  return ms / 60_000
}

/** Convert a user-entered base cooldown to milliseconds without rounding. */
export function cooldownMs(minutes: number): number {
  return Math.max(0.5, minutes) * 60_000
}

/** Convert a user-entered recovery grace to minutes. */
export function graceMinutes(ms: number): number {
  return ms / 60_000
}

/** Convert a user-entered recovery grace to milliseconds without rounding. */
export function graceMs(minutes: number): number {
  return Math.max(0, minutes) * 60_000
}
