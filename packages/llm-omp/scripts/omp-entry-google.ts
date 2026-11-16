/**
 * Bundle entry for the omp Google Cloud Code Assist transport.
 *
 * The artifact serves the Cloud Code Assist route: `streamGoogleGeminiCli`
 * dispatches on `model.provider`, so the plugin never selects a provider code
 * path. Only that entry point is exported.
 *
 * @module dsh-llm-omp-transports/omp-entry-google
 */
import { streamGoogleGeminiCli } from '@oh-my-pi/pi-ai/providers/google-gemini-cli'

export { streamGoogleGeminiCli }
