/**
 * The loopback callback listener and the shared callback parser — offline.
 *
 * Every test binds `127.0.0.1` on an ephemeral port and talks to it with the
 * runtime's own `fetch` over the loopback interface; nothing leaves the machine.
 * The listener is the part the sign-in cannot fake: a socket that must close on
 * every path, and a callback that must settle exactly once.
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { connect } from 'node:net'

import { describe, expect, it } from 'vitest'

import {
  GoogleAuthError,
  parseCallbackUrl,
  refusedSignIn,
  startCallbackListener,
} from '../src/google/callback-listener.js'
import type { CallbackListener } from '../src/google/callback-listener.js'
import { GOOGLE_ANTIGRAVITY_FACTS, GOOGLE_GEMINI_CLI_FACTS } from '../src/google/route.js'

/** Start a listener on an ephemeral port and always stop it. */
async function withListener(
  run: (listener: CallbackListener) => Promise<void>,
  options: { expectedState?: string; port?: number } = {},
): Promise<void> {
  const listener = await startCallbackListener({
    facts: GOOGLE_GEMINI_CLI_FACTS,
    expectedState: options.expectedState ?? 'state-1',
    port: options.port ?? 0,
  })
  try {
    await run(listener)
  } finally {
    await listener.close()
  }
}

/** A server that holds a port, so the listener has to fall back. */
async function holdPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const server: Server = createServer((_request, response) => response.end('held'))
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
  return {
    port,
    release: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

describe('parseCallbackUrl', () => {
  it('reads the code and state out of a callback URL', () => {
    expect(parseCallbackUrl('http://127.0.0.1:8085/oauth2callback?code=abc&state=s1')).toEqual({
      code: 'abc',
      state: 's1',
    })
    expect(parseCallbackUrl('  http://127.0.0.1:8085/oauth2callback?code=abc  ')).toEqual({ code: 'abc' })
  })

  it('reads a bare code with an optional #state, as the paste prompt may deliver it', () => {
    expect(parseCallbackUrl('abc')).toEqual({ code: 'abc' })
    expect(parseCallbackUrl('abc#s1')).toEqual({ code: 'abc', state: 's1' })
  })

  it('refuses an empty paste and a URL without a code', () => {
    expect(() => parseCallbackUrl('   ')).toThrowError(GoogleAuthError)
    expect(() => parseCallbackUrl('   ')).toThrowError(/empty/)
    expect(() => parseCallbackUrl('http://127.0.0.1:8085/oauth2callback?state=s1')).toThrowError(
      /names no code/,
    )
  })

  it('reads a code even when the same URL carries an error, as the Devin paste always did', () => {
    // The parser is shared with Devin's paste path, which must keep its old
    // behavior: the Google refusal is the Google call sites' decision.
    expect(parseCallbackUrl('http://127.0.0.1:8085/oauth2callback?error=access_denied&code=abc')).toEqual({
      code: 'abc',
    })
    expect(() => parseCallbackUrl('http://127.0.0.1:8085/oauth2callback?error=access_denied')).toThrowError(
      /names no code/,
    )
  })

  it('reads the refusal out of a redirect without touching the code', () => {
    expect(refusedSignIn('http://127.0.0.1:8085/oauth2callback?error=access_denied')).toBe('access_denied')
    expect(refusedSignIn('http://127.0.0.1:8085/oauth2callback?error=&code=abc')).toBeUndefined()
    expect(refusedSignIn('http://127.0.0.1:8085/oauth2callback?code=abc')).toBeUndefined()
    expect(refusedSignIn('abc#state')).toBeUndefined()
  })
})

describe('loopback listener', () => {
  it('binds an ephemeral port on 127.0.0.1 and serves only the route path', async () => {
    await withListener(async listener => {
      expect(listener.port).toBeGreaterThan(0)
      expect(listener.redirectUri).toBe(`http://127.0.0.1:${listener.port}/oauth2callback`)

      const notFound = await fetch(`http://127.0.0.1:${listener.port}/something-else`)
      expect(notFound.status).toBe(404)

      const wrongMethod = await fetch(listener.redirectUri, { method: 'POST' })
      expect(wrongMethod.status).toBe(405)
    })
  })

  it('settles on a matching callback and answers the browser', async () => {
    await withListener(async listener => {
      const response = await fetch(`${listener.redirectUri}?code=abc&state=state-1`)
      expect(response.status).toBe(200)
      await expect(listener.callback).resolves.toEqual({ code: 'abc', state: 'state-1' })
    })
  })

  it('answers 400 to a state this attempt did not mint and keeps listening', async () => {
    await withListener(async listener => {
      // Any page or local process can reach this port during the sign-in window;
      // one bogus GET must not be able to kill the attempt.
      const bogus = await fetch(`${listener.redirectUri}?code=attacker&state=someone-else`)
      expect(bogus.status).toBe(400)
      // The same holds for an error callback and a code-less one.
      expect((await fetch(`${listener.redirectUri}?error=access_denied&state=state-1`)).status).toBe(400)
      expect((await fetch(`${listener.redirectUri}?state=state-1`)).status).toBe(400)

      const response = await fetch(`${listener.redirectUri}?code=abc&state=state-1`)
      expect(response.status).toBe(200)
      await expect(listener.callback).resolves.toEqual({ code: 'abc', state: 'state-1' })
    })
  })

  it('falls back to an ephemeral port when the route port is taken', async () => {
    const held = await holdPort()
    try {
      const listener = await startCallbackListener({
        facts: GOOGLE_GEMINI_CLI_FACTS,
        expectedState: 'state-1',
        port: held.port,
      })
      try {
        expect(listener.port).not.toBe(held.port)
        expect(listener.port).toBeGreaterThan(0)
        // The advertised URI follows the port it actually got, or the browser
        // would land on the other process.
        expect(listener.redirectUri).toContain(`:${listener.port}/`)
      } finally {
        await listener.close()
      }
    } finally {
      await held.release()
    }
  })

  it('closes the socket and settles when the attempt is cancelled', async () => {
    const controller = new AbortController()
    const listener = await startCallbackListener({
      facts: GOOGLE_GEMINI_CLI_FACTS,
      expectedState: 'state-1',
      port: 0,
      signal: controller.signal,
    })
    const port = listener.port
    controller.abort()
    await expect(listener.callback).rejects.toThrowError(/cancelled/)
    // Nothing keeps listening: the port refuses connections now.
    await expect(fetch(`http://127.0.0.1:${port}/oauth2callback?code=abc&state=state-1`)).rejects.toThrow()
    await listener.close()
  })

  it('serves the Antigravity route’s path from its own facts', async () => {
    const listener = await startCallbackListener({
      facts: GOOGLE_ANTIGRAVITY_FACTS,
      expectedState: 'state-2',
      port: 0,
    })
    try {
      // The gemini-cli path belongs to the other route's registration.
      expect((await fetch(`http://127.0.0.1:${listener.port}/oauth2callback?code=abc&state=state-2`)).status).toBe(404)
      const accepted = await fetch(`http://127.0.0.1:${listener.port}/oauth-callback?code=abc&state=state-2`)
      expect(accepted.status).toBe(200)
      await expect(listener.callback).resolves.toEqual({ code: 'abc', state: 'state-2' })
    } finally {
      await listener.close()
    }
  })
})

describe('startCallbackListener robustness', () => {
  it('answers 400 for a malformed request target and keeps serving', async () => {
    await withListener(async listener => {
      // Node hands the handler the raw request target; an absolute-form one it
      // cannot parse must be a 400 response, not an exception out of the handler.
      const status = await rawRequest(listener.port, 'GET http://[::1 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
      expect(status).toBe(400)

      const response = await fetch(`${listener.redirectUri}?code=abc&state=state-1`)
      expect(response.status).toBe(200)
      await expect(listener.callback).resolves.toEqual({ code: 'abc', state: 'state-1' })
    })
  })
})

/** Send a raw request line over a socket and read back the status code. */
function rawRequest(port: number, payload: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(payload))
    let head = ''
    socket.on('data', chunk => {
      head += String(chunk)
    })
    socket.on('error', reject)
    socket.on('close', () => {
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(head)
      if (match === null) reject(new Error(`no status line in ${JSON.stringify(head)}`))
      else resolve(Number(match[1]))
    })
  })
}
