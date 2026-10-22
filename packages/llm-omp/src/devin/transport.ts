/**
 * Devin route data that is not a wire projection.
 *
 * The Devin chat request is built by the transport from its own client
 * identity: `streamDevin` announces the Devin CLI and sets `connect-go` as
 * `user-agent` (`@oh-my-pi/pi-ai@18.12.3` `src/providers/devin.ts`), and it
 * merges caller `headers` last, so passing DSH's attribution headers as request
 * options would overwrite that identity on every call. The seam still requires
 * attribution on each provider request (`@deepseek-ai/dsh-llm` `LlmAdapter`
 * contract), so the route passes this `fetch` instead: it fills only the
 * headers a request left absent. The header-less `GetUserJwt` handshake gains
 * DSH's `user-agent`; the chat request keeps the transport's own.
 *
 * This is the documented deviation (PM decision B2) recorded in
 * `docs/known-limits.md`.
 *
 * @module dsh-llm-omp-transports/devin/transport
 */
import { attributionHeaders } from '@deepseek-ai/dsh-llm'

/**
 * Pass through to the runtime `fetch`, adding the attribution headers a
 * request omitted.
 *
 * @param input - the request URL or object the transport is fetching.
 * @param init - the transport's own request init; never mutated.
 * @returns the runtime fetch's response.
 */
export function attributionPreservingFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers)
  let filled = false
  for (const [name, value] of Object.entries(attributionHeaders())) {
    if (headers.has(name)) continue
    headers.set(name, value)
    filled = true
  }
  // Passing the original init when nothing was missing keeps this wrapper
  // observationally invisible to requests that already carry attribution.
  return fetch(input, filled ? { ...init, headers } : init)
}
