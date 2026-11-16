/**
 * Bundle entry for the Antigravity CLI sign-in, refresh and credential staging.
 *
 * `/login` for this route is agy's own OAuth dance: the provider spawns
 * `agy acp --login` in an isolated directory, reads the Google authorization URL
 * off its output, feeds the pasted code back, and exports the consumer grant the
 * CLI wrote. Keeping that logic in the pin (rather than copying it) is why this
 * entry exists beside the transport entry — the plugin only maps the host's
 * authorization callbacks onto it.
 *
 * @module dsh-llm-omp-transports/omp-entry-antigravity-login
 */
export { loginAntigravityCli, refreshAntigravityCli } from '@oh-my-pi/pi-ai/registry/oauth/antigravity-cli'
export {
  agyCredentialEnv,
  agyCredentialKey,
  exportAgyCredentials,
  stageAgyCredentials,
} from '@oh-my-pi/pi-ai/providers/antigravity-cli/credentials'
export { agyGeminiDir } from '@oh-my-pi/pi-ai/providers/antigravity-cli/binary'
