/**
 * Attribution-preserving `fetch` shared by the routes whose transport owns its
 * own client identity.
 *
 * The seam requires attribution on every provider request
 * (`@deepseek-ai/dsh-llm` `LlmAdapter` contract), but these wires set a vendor
 * `user-agent` that the transport merges caller `headers` over — Devin's
 * `connect-go`, Google's `GeminiCLI/…` and `antigravity/hub/…`. Passing DSH's
 * attribution as request options would therefore overwrite the identity on
 * every call. The route passes this `fetch` instead: it fills only the headers
 * a request left absent, so a header-less handshake gains DSH's `user-agent`
 * and the vendor request keeps its own.
 *
 * This is the documented deviation (PM decision B2/D10) recorded in
 * `docs/known-limits.md`.
 *
 * @module dsh-llm-omp-transports/transport/fetch
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
