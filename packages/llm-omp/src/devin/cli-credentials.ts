/**
 * Import the seat key the official Devin CLI already stores.
 *
 * The twin of omp's `devin-cli` login hook (`pi-ai/src/registry/oauth/devin-cli.ts`,
 * `login "custom" hook="devin-cli"`): `devin auth login` leaves a
 * `windsurf_api_key` in `credentials.toml`, and that raw seat key is the same
 * credential the Cascade API accepts. Nothing here touches the network and
 * nothing prompts — a human who already signed in with the CLI should not have
 * to sign in again.
 *
 * The plugin may not import `@oh-my-pi/*` at runtime, so the probe order, the
 * field name and the accepted API hosts are copied from that hook. The key is
 * only for the default host: a CLI bound to another `api_server_url` was issued
 * a key this route's requests would not authenticate with, so it is refused
 * instead of adopted.
 *
 * @module dsh-llm-omp-transports/devin/cli-credentials
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

/** Hosts verified to accept the same raw seat key (the pinned hook's list). */
const KNOWN_API_HOSTS = ['server.codeium.com', 'server.enterprise.windsurf.com']

/** A sign-in step that failed in a way the flow reports as `AUTH_FAILED`. */
export class DevinCliCredentialsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DevinCliCredentialsError'
  }
}

/** Where `devin auth login` may have written `credentials.toml`, in probe order. */
export function devinCliCredentialPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string[] {
  const windows = platform === 'win32'
  // The paths follow the platform, not the host, so a test can pin both.
  const p = windows ? win32 : posix
  const dataDirs = [
    windows ? env.APPDATA : undefined,
    env.XDG_DATA_HOME,
    p.join(home, '.local', 'share'),
    // The Devin CLI documents macOS as XDG-only; the Library path is probed
    // because that is where a Library-using build writes (omp probes it too).
    windows ? undefined : p.join(home, 'Library', 'Application Support'),
  ]
  const files = dataDirs
    .filter((dir): dir is string => dir !== undefined && dir !== '')
    .map(dir => p.join(dir, 'devin', 'credentials.toml'))
  return [...new Set(files)]
}

/**
 * The seat key in one `credentials.toml` body.
 *
 * The file is a flat TOML document of `key = "value"` lines; only two keys are
 * read, so no TOML parser is pulled in for it.
 *
 * shortcut: flat `key = "value"` TOML only, upgrade if Devin ever nests the key.
 *
 * @param text - the file's contents.
 * @param file - the path, for error messages.
 * @returns the raw seat key.
 * @throws DevinCliCredentialsError when the file carries no usable key.
 */
export function parseDevinCliCredentials(text: string, file: string): string {
  const fields: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_.-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(line)
    if (match !== null) fields[match[1]!] = match[2]!.replace(/\\(.)/g, '$1')
  }
  const key = fields.windsurf_api_key?.trim() ?? ''
  if (key === '') {
    throw new DevinCliCredentialsError(
      `the Devin CLI credentials at ${file} carry no windsurf_api_key; run \`devin auth login\`, then retry`,
    )
  }
  const serverUrl = fields.api_server_url
  if (serverUrl !== undefined && serverUrl !== '') {
    let host: string | undefined
    try {
      host = new URL(serverUrl).host
    } catch {
      host = undefined
    }
    if (host === undefined || !KNOWN_API_HOSTS.includes(host)) {
      throw new DevinCliCredentialsError(
        `the Devin CLI credentials at ${file} point at unsupported API server "${serverUrl}" (supported: ${KNOWN_API_HOSTS.join(', ')})`,
      )
    }
  }
  return key
}

/**
 * Read the seat key from the first candidate file that exists.
 *
 * @param paths - candidates in probe order.
 * @returns the raw seat key.
 * @throws DevinCliCredentialsError when no candidate exists or none is usable.
 */
export async function readDevinCliCredentials(
  paths: readonly string[] = devinCliCredentialPaths(),
): Promise<string> {
  for (const file of paths) {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new DevinCliCredentialsError(
        `the Devin CLI credentials at ${file} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
    return parseDevinCliCredentials(text, file)
  }
  throw new DevinCliCredentialsError(
    `no Devin CLI credentials were found (probed: ${paths.join(', ')}); run \`devin auth login\`, then retry`,
  )
}
