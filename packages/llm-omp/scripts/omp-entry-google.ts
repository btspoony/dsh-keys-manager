/**
 * Bundle entry for the omp Google Cloud Code Assist transport.
 *
 * One artifact serves both Google routes: `streamGoogleGeminiCli` dispatches on
 * `model.provider` (`google-gemini-cli` or `google-antigravity`), so the plugin
 * never selects a provider code path. Only that entry point is exported.
 *
 * @module dsh-llm-omp-transports/omp-entry-google
 */
import { streamGoogleGeminiCli } from '@oh-my-pi/pi-ai/providers/google-gemini-cli'

export { streamGoogleGeminiCli }
