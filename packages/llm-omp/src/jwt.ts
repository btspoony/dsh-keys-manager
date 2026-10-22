/**
 * JWT inspection shared by both routes' login flows.
 *
 * Both vendors mint a bearer the transport treats as opaque, but the expiry the
 * seam stores must be a number: Cursor reads `exp` with a five-minute skew and a
 * one-hour fallback; Devin reads the same `exp` with the same skew and a
 * 365-day fallback (its KDL rule declares `expires "jwt" fallback-ms=31536000000`
 * and `refresh "none"`). Neither token is verified — this is bookkeeping, not
 * authentication.
 *
 * @module dsh-llm-omp-transports/jwt
 */

/** How the expiry is derived from one token. */
export interface JwtExpiryOptions {
  /** Safety margin subtracted from `exp`, in ms. */
  readonly skewMs?: number
  /** Lifetime assumed when the token carries no readable `exp`. */
  readonly fallbackMs: number
  /** Clock, for tests that pin a moment. */
  readonly now?: () => number
}

/**
 * Decode a JWT payload.
 *
 * @param token - the bearer token.
 * @returns the payload object, or undefined when the token is not a three-part JWT.
 */
export function readJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as unknown
    return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Derive the stored expiry (epoch ms) from a token.
 *
 * @param token - the bearer token.
 * @param options - skew, fallback lifetime and clock.
 * @returns `exp * 1000 - skewMs`, or `now() + fallbackMs` for a non-JWT token.
 */
export function jwtExpiry(token: string, options: JwtExpiryOptions): number {
  const exp = readJwtPayload(token)?.exp
  if (typeof exp === 'number' && Number.isFinite(exp)) return exp * 1000 - (options.skewMs ?? 0)
  return (options.now ?? Date.now)() + options.fallbackMs
}
