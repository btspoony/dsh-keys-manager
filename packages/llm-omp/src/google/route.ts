/**
 * The two Google routes' sign-in facts: endpoints, client identity, scopes and
 * callback.
 *
 * Both routes are declarative `login "oauth-code"` rules in the pinned omp
 * catalog (`compat/rules/auth/google-gemini-cli.kdl` and
 * `google-antigravity.kdl`), executed by omp's generic engine. This module
 * copies the rules' facts because the published plugin may not import
 * `@oh-my-pi/*` at runtime, and `tests/auth-google.test.ts` pins what the plugin
 * itself sends.
 *
 * The differences between the two rules are exactly what this module keeps
 * apart: the OAuth client (Antigravity's reaches Google's extra models), the
 * scopes, the loopback port and path, and the Cloud Code Assist host the
 * project-discovery calls go to.
 *
 * The client id and secret are **not** written here. They are Google's public
 * installed-app credentials, which GitHub push protection treats as secrets, so
 * `scripts/generate-google-client-facts.mjs` derives them from the pinned rules
 * at build time into an ignored module (`./client-facts.generated.ts`).
 *
 * @module dsh-llm-omp-transports/google/route
 */
import { GOOGLE_CLIENT_FACTS } from './client-facts.generated.js'

/** The two Google route ids, spelled once for this module's own types. */
export type GoogleRouteId = 'google-gemini-cli' | 'google-antigravity'

/** The Cloud Code Assist host the provisioning calls go to. */
export const GEMINI_CLI_ENDPOINT = 'https://cloudcode-pa.googleapis.com'
/** Antigravity reads and provisions projects through its own daily host. */
export const ANTIGRAVITY_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com'

/** The shared Google OAuth endpoints: both rules point at the same two pages. */
export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json'

/** The loopback listener one route advertises as its redirect URI. */
export interface GoogleCallbackFacts {
  readonly hostname: string
  /** Port the rule declares; the listener falls back to an ephemeral one when it is taken. */
  readonly port: number
  readonly path: string
}

/** How one route discovers its Cloud Code Assist project. */
export interface GoogleDiscoveryFacts {
  /**
   * Which discovery script to run: `gemini-cli` reads `loadCodeAssist` tiers and
   * may need `GOOGLE_CLOUD_PROJECT`; `antigravity` onboards the free tier and
   * re-reads the project.
   */
  readonly kind: 'gemini-cli' | 'antigravity'
  /** Base URL of the Cloud Code Assist API. */
  readonly endpoint: string
  /** Vendor `user-agent` the discovery calls identify as. */
  readonly userAgent: string
  /** `client-metadata` header value; Gemini CLI sends one, Antigravity does not. */
  readonly clientMetadata?: string
}

/** Everything one Google route's sign-in needs, decoded from the pinned rule. */
export interface GoogleRouteFacts {
  readonly id: GoogleRouteId
  readonly label: string
  readonly clientId: string
  readonly clientSecret: string
  readonly scopes: readonly string[]
  readonly callback: GoogleCallbackFacts
  readonly discovery: GoogleDiscoveryFacts
}

/**
 * The Gemini CLI route: the `google-gemini-cli.kdl` rule, whose client identity
 * comes from the generated module.
 */
export const GOOGLE_GEMINI_CLI_FACTS: GoogleRouteFacts = {
  id: 'google-gemini-cli',
  label: 'Google Gemini CLI',
  ...GOOGLE_CLIENT_FACTS['google-gemini-cli'],
  scopes: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],
  callback: { hostname: '127.0.0.1', port: 8085, path: '/oauth2callback' },
  discovery: {
    kind: 'gemini-cli',
    endpoint: GEMINI_CLI_ENDPOINT,
    // omp composes this from the host platform; pinning the reference platform
    // keeps the identity stable across machines, and only the version gates
    // model access upstream.
    userAgent: 'GeminiCLI/0.46.0/gemini-3.1-pro-preview (darwin; arm64; terminal)',
    clientMetadata: 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
  },
}

/**
 * The Antigravity route: the `google-antigravity.kdl` rule, whose client reaches
 * the Gemini, Claude and GPT-OSS rows on the same API.
 */
export const GOOGLE_ANTIGRAVITY_FACTS: GoogleRouteFacts = {
  id: 'google-antigravity',
  label: 'Google Antigravity',
  ...GOOGLE_CLIENT_FACTS['google-antigravity'],
  scopes: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
  ],
  callback: { hostname: '127.0.0.1', port: 51121, path: '/oauth-callback' },
  discovery: {
    kind: 'antigravity',
    endpoint: ANTIGRAVITY_ENDPOINT,
    // The backend gates newer models on this client version; the captured
    // reference build is what the pinned rule was recorded from.
    userAgent: 'antigravity/hub/2.19.1 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)',
  },
}

/** The redirect URI one route advertises, on the port its listener actually got. */
export function googleRedirectUri(facts: GoogleRouteFacts, port: number = facts.callback.port): string {
  return `http://${facts.callback.hostname}:${port}${facts.callback.path}`
}
