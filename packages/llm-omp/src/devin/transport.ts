/**
 * Devin route data that is not a wire projection.
 *
 * The Devin chat request is built by the transport from its own client
 * identity: `streamDevin` announces the Devin CLI and sets `connect-go` as
 * `user-agent` (`@oh-my-pi/pi-ai@18.12.3` `src/providers/devin.ts`), and it
 * merges caller `headers` last, so passing DSH's attribution headers as request
 * options would overwrite that identity on every call. The seam still requires
 * attribution on each provider request (`@deepseek-ai/dsh-llm` `LlmAdapter`
 * contract), so the route passes the shared
 * {@link module:dsh-llm-omp-transports/transport/fetch attributionPreservingFetch}
 * instead: it fills only the headers a request left absent. The header-less
 * `GetUserJwt` handshake gains DSH's `user-agent`; the chat request keeps the
 * transport's own.
 *
 * The wrapper lives in `src/transport/fetch.ts` because the Google routes need
 * the same behaviour for their vendor identities; this module keeps the
 * route-local export the shipped tests and projection import.
 *
 * This is the documented deviation (PM decision B2) recorded in
 * `docs/known-limits.md`.
 *
 * @module dsh-llm-omp-transports/devin/transport
 */
export { attributionPreservingFetch } from '../transport/fetch.js'
