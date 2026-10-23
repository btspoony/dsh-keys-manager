/**
 * The loopback callback listener the two Google routes host during sign-in.
 *
 * omp's declarative engine starts a Bun server on the rule's `callback` block;
 * the plugin cannot port that, and Node's `node:http` gives the same thing: bind
 * `127.0.0.1` on the route's port (falling back to an ephemeral port when
 * another process holds it, which is what the rule's `portFallback` asks for),
 * serve only the rule's path, and settle one promise with the code the browser
 * delivered.
 *
 * The listener is the *fast* half of the sign-in: a human whose browser cannot
 * reach the loopback (a remote session) still gets through the paste prompt in
 * `src/google/auth.ts`, which races this listener.
 *
 * @module dsh-llm-omp-transports/google/callback-listener
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

import { googleRedirectUri } from './route.js'
import type { GoogleRouteFacts } from './route.js'

/** A sign-in step that failed in a way the flow reports as `AUTH_FAILED`. */
export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GoogleAuthError'
  }
}

/** The code and optional state recovered from a callback. */
export interface GoogleCallback {
  readonly code: string
  readonly state?: string
}

/**
 * Parse a callback URL, a bare code, or `code#state`.
 *
 * Generalised from the Devin paste parser, which it must keep behaving like: the
 * text is any callback address a human can paste, so an `error=` parameter is
 * not this parser's business — a URL that carries both an error and a code still
 * yields the code. The Google refusal is decided by its call sites
 * ({@link refusedSignIn}, the listener's handler and `loginGoogle`), so the
 * shipped Devin paste path keeps the behavior it had before the lift.
 *
 * @param text - a full callback URL, or a bare code with an optional `#state`.
 * @returns the code and, when the text carried one, the state it claimed.
 * @throws GoogleAuthError when the text names no code.
 */
export function parseCallbackUrl(text: string): GoogleCallback {
  const trimmed = text.trim()
  if (trimmed === '') throw new GoogleAuthError('the pasted callback is empty')

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      throw new GoogleAuthError('the pasted callback URL is malformed')
    }
    const code = url.searchParams.get('code')?.trim()
    if (code === undefined || code === '') throw new GoogleAuthError('the pasted callback URL names no code')
    const state = url.searchParams.get('state')?.trim()
    return { code, ...(state === undefined || state === '' ? {} : { state }) }
  }

  // A bare code, optionally with the state after a `#`.
  const hash = trimmed.indexOf('#')
  const code = (hash === -1 ? trimmed : trimmed.slice(0, hash)).trim()
  const state = hash === -1 ? '' : trimmed.slice(hash + 1).trim()
  if (code === '') throw new GoogleAuthError('the pasted callback names no code')
  return { code, ...(state === '' ? {} : { state }) }
}

/**
 * Read the `error=` parameter of an OAuth redirect, if the text carries one.
 *
 * Kept out of {@link parseCallbackUrl} so that parser stays a behaviour-preserving
 * generalisation of the Devin paste path; the Google sign-in calls it before
 * trusting a code, because a consent screen that returned an error has no grant.
 *
 * @param text - a callback URL the browser or a paste supplied.
 * @returns the provider's error code, or `undefined` when there is none.
 */
export function refusedSignIn(text: string): string | undefined {
  const trimmed = text.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return undefined
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  const error = url.searchParams.get('error')?.trim()
  return error === undefined || error === '' ? undefined : error
}

/** Options for {@link startCallbackListener}; the signal comes from the flow attempt. */
export interface CallbackListenerOptions {
  readonly facts: GoogleRouteFacts
  /** The state this attempt minted; a callback that carries another one is refused. */
  readonly expectedState: string
  /** First port to try; `0` asks for an ephemeral one (tests, and callers that must not own the rule's port). */
  readonly port?: number
  readonly signal?: AbortSignal
}

/** A listening loopback server and the one callback it will settle. */
export interface CallbackListener {
  /** The port actually bound (the rule's own, or an ephemeral fallback). */
  readonly port: number
  readonly redirectUri: string
  /** Settles with the callback, or rejects with {@link GoogleAuthError}. */
  readonly callback: Promise<GoogleCallback>
  /** Stop serving; also settles {@link callback} with a cancellation. */
  close(): Promise<void>
}

/** How many ephemeral binds a taken port may try before the listener gives up. */
const FALLBACK_ATTEMPTS = 3

/**
 * Start the listener and wait for one browser callback.
 *
 * Resolves only once the socket is bound, so the caller can advertise the port
 * it actually got in the redirect URI.
 *
 * @param options - route facts, the attempt's state, the preferred port and the
 *   attempt signal.
 * @returns the bound listener; the caller owns {@link CallbackListener.close}.
 * @throws GoogleAuthError when the preferred port and every fallback stay taken.
 */
export async function startCallbackListener(options: CallbackListenerOptions): Promise<CallbackListener> {
  const { facts, expectedState, signal } = options
  let settle: (callback: GoogleCallback) => void = () => {}
  let fail: (error: Error) => void = () => {}
  const callback = new Promise<GoogleCallback>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  // The flow may lose the race to the paste prompt and never await this; keep a
  // rejected settlement from surfacing as an unhandled rejection.
  callback.catch(() => {})

  let server: Server | undefined
  let port = options.port ?? facts.callback.port
  let closed = false
  let settled = false

  const closeServer = (): Promise<void> =>
    new Promise(resolve => {
      if (server === undefined || !server.listening) {
        resolve()
        return
      }
      // Node keeps idle and keep-alive sockets alive across `close`; the browser
      // holds one after the callback page, so drop them explicitly.
      server.closeAllConnections()
      server.close(() => resolve())
    })

  const onAbort = (): void => {
    defer(() => stop(new GoogleAuthError('the sign-in attempt was cancelled')))
  }

  const stop = async (error?: Error): Promise<void> => {
    signal?.removeEventListener('abort', onAbort)
    if (!closed) {
      closed = true
      await closeServer()
    }
    // A listener closed before a callback arrived (the paste prompt won the
    // race, or the attempt was cancelled) still settles, so a caller that
    // awaited it never hangs.
    if (!settled) {
      settled = true
      fail(error ?? new GoogleAuthError('the sign-in listener closed before a callback arrived'))
    }
  }

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    let url: URL
    try {
      url = new URL(request.url ?? '/', `http://${facts.callback.hostname}:${port}`)
    } catch {
      // Node hands the raw request target through; one it cannot parse must not
      // throw out of the handler (that would take the host process down).
      respond(response, 400, 'Bad request', 'This address is not a valid callback.')
      return
    }
    if (url.pathname !== facts.callback.path) {
      respond(response, 404, 'Not found', 'This page is not part of the sign-in.')
      return
    }
    if (request.method !== 'GET') {
      respond(response, 405, 'Method not allowed', 'The sign-in callback is a GET request.')
      return
    }
    const error = url.searchParams.get('error')?.trim()
    if (error !== undefined && error !== '') {
      const description = url.searchParams.get('error_description')?.trim()
      respond(response, 400, 'Sign-in refused', 'Google refused the sign-in. Return to the terminal.')
      defer(() => stop(new GoogleAuthError(`Google refused the sign-in: ${error}${description ? ` (${description})` : ''}`)))
      return
    }
    const state = url.searchParams.get('state')?.trim()
    if (state !== expectedState) {
      respond(response, 400, 'Wrong state', 'This callback does not belong to the running sign-in attempt.')
      defer(() => stop(new GoogleAuthError('the callback state does not match this sign-in attempt')))
      return
    }
    const code = url.searchParams.get('code')?.trim()
    if (code === undefined || code === '') {
      respond(response, 400, 'Missing code', 'Google returned no authorization code.')
      defer(() => stop(new GoogleAuthError('the callback names no authorization code')))
      return
    }
    respond(response, 200, 'Signed in', 'You can close this window and return to the terminal.')
    if (!settled) {
      settled = true
      settle({ code, state })
    }
    defer(() => stop())
  }

  server = createServer(handler)
  try {
    port = await listen(server, facts.callback.hostname, port, FALLBACK_ATTEMPTS)
  } catch (cause) {
    await stop(cause instanceof GoogleAuthError ? cause : new GoogleAuthError(String(cause)))
    throw cause instanceof GoogleAuthError ? cause : new GoogleAuthError(String(cause))
  }
  // `listen` owns the bind-phase error; a later one is the socket dying under a
  // live attempt.
  server.on('error', cause => {
    defer(() => stop(new GoogleAuthError(`the loopback listener failed: ${cause.message}`)))
  })

  signal?.addEventListener('abort', onAbort, { once: true })

  return {
    get port() {
      return port
    },
    get redirectUri() {
      return googleRedirectUri(facts, port)
    },
    callback,
    close: () => stop(),
  }
}

/**
 * Bind the route's port, falling back to an ephemeral one when it is taken.
 *
 * @param server - the callback server, already wired to its handler.
 * @param hostname - loopback host to bind.
 * @param port - the rule's port.
 * @param attempts - how many ephemeral binds may be tried.
 * @returns the port actually bound.
 */
async function listen(server: Server, hostname: string, port: number, attempts: number): Promise<number> {
  try {
    return await bind(server, hostname, port)
  } catch (cause) {
    if (!isAddressInUse(cause)) throw new GoogleAuthError(`the loopback listener failed: ${describe(cause)}`)
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await bind(server, hostname, 0)
    } catch (cause) {
      if (!isAddressInUse(cause)) throw new GoogleAuthError(`the loopback listener failed: ${describe(cause)}`)
    }
  }
  throw new GoogleAuthError(
    `could not bind the sign-in listener: ${hostname}:${port} and ${attempts} ephemeral ports are taken`,
  )
}

/** Resolve once the server is listening on `port`. */
function bind(server: Server, hostname: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (cause: Error): void => {
      server.off('listening', onListening)
      reject(cause)
    }
    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, hostname)
  })
}

/**
 * Run a settlement after the current request's response has flushed.
 *
 * Closing the server inside the request callback would drop the page the
 * browser is waiting for; one turn of the event loop is enough.
 */
function defer(task: () => Promise<void>): void {
  setImmediate(() => {
    void task()
  })
}

/** Whether a failed bind means another process already holds the port. */
function isAddressInUse(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null | undefined)?.code
  return code === 'EADDRINUSE'
}

/** One-line description of a bind failure. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Answer the browser with a plain page, then finish. */
function respond(response: ServerResponse, status: number, title: string, message: string): void {
  const body = `<!doctype html><meta charset="utf-8"><title>${title}</title><p>${message}</p>`
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}
