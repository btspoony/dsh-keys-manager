/**
 * Driver tests for the two in-process omp sign-ins.
 *
 * Nothing here touches a provider: the omp drivers are replaced by doubles that
 * replay the callback sequences from `@oh-my-pi/pi-ai` (verified by the build
 * gate in `tests/omp-oauth-build.test.ts`), and every fetch is a local stub.
 * The suite must pass with `lib/omp-oauth/` absent — under `vitest` the adapter
 * resolves to a path that does not exist, which is what the missing-bundle test
 * asserts.
 */
import { describe, expect, it } from 'vitest'

import type { AuthorizationInteractionLike } from '../src/host-types.js'
import {
  OmpOAuthBundleMissingError,
  ompOAuthAdapter,
  type OmpOAuthAdapter,
  type OmpOAuthController,
  type OmpOAuthCredentials,
} from '../src/oauth/adapter.js'
import { SIGN_IN_PROVIDERS, signInCapable, signInProvider } from '../src/oauth/providers.js'
import { SignInCancelledError, SignInUnavailableError, runSignIn } from '../src/oauth/signin.js'

/** One recorded interaction call. */
type Call =
  | { kind: 'notify'; message: string; url?: string }
  | { kind: 'prompt'; message: string; promptKind: string | undefined }

/** The attempt surface double: records everything, answers prompts in order. */
function interactionDouble(answers: string[] = []): {
  interaction: AuthorizationInteractionLike
  calls: Call[]
} {
  const calls: Call[] = []
  return {
    calls,
    interaction: {
      notify: notice => {
        calls.push({ kind: 'notify', message: notice.message, ...(notice.url === undefined ? {} : { url: notice.url }) })
      },
      prompt: async prompt => {
        calls.push({ kind: 'prompt', message: prompt.message, promptKind: prompt.kind })
        const answer = answers.shift()
        if (answer === undefined) throw new Error('the test prompt has no queued answer')
        return answer
      },
    },
  }
}

/** Replays omp's callback sequence; `fetch` is only checked for forwarding. */
function adapterDouble(overrides: Partial<OmpOAuthAdapter> = {}): OmpOAuthAdapter {
  return {
    loginKilo: async (controller: OmpOAuthController): Promise<OmpOAuthCredentials> => {
      controller.onAuth?.({ url: 'https://api.kilo.ai/verify', instructions: 'Enter code: ABCD-1234' })
      controller.onProgress?.('Waiting for browser authentication...')
      const response = await controller.fetch?.('https://api.kilo.ai/api/device-auth/codes', { method: 'POST' })
      expect(response?.status).toBe(202)
      return { refresh: '', access: 'kilo-bearer', expires: 4_102_444_800_000 }
    },
    loginZaiCodingPlan: async (controller: OmpOAuthController): Promise<OmpOAuthCredentials> => {
      controller.onAuth?.({ url: 'https://chat.z.ai/api/oauth/authorize?state=abc', instructions: 'Complete Z.ai login.' })
      const pasted = await controller.onManualCodeInput?.(controller.signal)
      expect(pasted).toBe('zcode://zai-auth/callback?code=xyz')
      controller.onProgress?.('Waiting for pasted authorization code...')
      return { refresh: '', access: 'ak.secret', expires: 8.64e15 }
    },
    ...overrides,
  }
}

/** A fetch stub that answers 202; it must never reach a real endpoint. */
const fetches: string[] = []
const fetchDouble = (async (input: string | URL | Request) => {
  fetches.push(String(input))
  return new Response(JSON.stringify({ status: 'pending' }), { status: 202 })
}) as typeof fetch

describe('kilo sign-in', () => {
  it('maps onAuth and onProgress onto attempt notices and returns the minted bearer', async () => {
    const { interaction, calls } = interactionDouble()
    const credential = await runSignIn('kilo', { interaction, fetch: fetchDouble, adapter: adapterDouble() })
    expect(credential).toEqual({ access: 'kilo-bearer', expires: 4_102_444_800_000 })
    // Kilo's user code travels inside `instructions`; the driver copies it.
    expect(calls).toEqual([
      { kind: 'notify', message: 'Enter code: ABCD-1234', url: 'https://api.kilo.ai/verify' },
      { kind: 'notify', message: 'Waiting for browser authentication...' },
    ])
    // The fetch seam is forwarded to the omp controller (never the global one).
    expect(fetches).toHaveLength(1)
  })
})

describe('zai sign-in', () => {
  it('prompts for the pasted redirect and returns the durable key as access', async () => {
    const { interaction, calls } = interactionDouble(['zcode://zai-auth/callback?code=xyz'])
    const credential = await runSignIn('zai', { interaction, adapter: adapterDouble() })
    expect(credential.access).toBe('ak.secret')
    expect(calls).toEqual([
      { kind: 'notify', message: 'Complete Z.ai login.', url: 'https://chat.z.ai/api/oauth/authorize?state=abc' },
      { kind: 'prompt', message: 'Paste the final redirect URL or the authorization code', promptKind: 'text' },
      { kind: 'notify', message: 'Waiting for pasted authorization code...' },
    ])
  })

  it('re-parks the paste prompt when omp re-asks after an input without a code', async () => {
    const { interaction, calls } = interactionDouble(['', 'zcode://zai-auth/callback?code=xyz'])
    const adapter = adapterDouble({
      loginZaiCodingPlan: async controller => {
        let pasted = ''
        while (!pasted) pasted = await controller.onManualCodeInput?.(controller.signal) ?? ''
        return { refresh: '', access: 'ak.from-second-paste', expires: 8.64e15 }
      },
    })
    const credential = await runSignIn('zai', { interaction, adapter })
    expect(credential.access).toBe('ak.from-second-paste')
    expect(calls.filter(call => call.kind === 'prompt')).toHaveLength(2)
  })
})

describe('prompt parity', () => {
  it('wires omp onPrompt to a text or secret attempt prompt', async () => {
    const { interaction, calls } = interactionDouble(['first', 'second'])
    const adapter = adapterDouble({
      loginKilo: async controller => {
        await controller.onPrompt?.({ message: 'Account email' })
        await controller.onPrompt?.({ message: 'Confirmation code', placeholder: '123456', secret: true })
        return { refresh: '', access: 'token', expires: 1 }
      },
    })
    await runSignIn('kilo', { interaction, adapter })
    expect(calls).toContainEqual({ kind: 'prompt', message: 'Account email', promptKind: 'text' })
    expect(calls).toContainEqual({ kind: 'prompt', message: 'Confirmation code', promptKind: 'secret' })
  })
})

describe('cancellation', () => {
  it('refuses to start when the attempt signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort('test')
    const { interaction } = interactionDouble()
    await expect(runSignIn('kilo', { interaction, signal: controller.signal, adapter: adapterDouble() })).rejects.toBeInstanceOf(
      SignInCancelledError,
    )
  })

  it('translates the controller cancellation into a named cancellation error', async () => {
    const controller = new AbortController()
    const { interaction } = interactionDouble()
    const adapter = adapterDouble({
      loginZaiCodingPlan: async ompController => {
        controller.abort('user closed the dialog')
        expect(ompController.signal).toBe(controller.signal)
        const cancelled = new Error('OAuth login cancelled')
        cancelled.name = 'LoginCancelledError'
        throw cancelled
      },
    })
    await expect(runSignIn('zai', { interaction, signal: controller.signal, adapter })).rejects.toBeInstanceOf(
      SignInCancelledError,
    )
  })
})

describe('provider failures', () => {
  it('keeps the provider error text intact', async () => {
    const { interaction } = interactionDouble()
    const adapter = adapterDouble({
      loginKilo: async () => {
        throw new Error('Authorization was denied')
      },
    })
    await expect(runSignIn('kilo', { interaction, adapter })).rejects.toThrow('Authorization was denied')
  })

  it('rejects an empty credential rather than committing nothing', async () => {
    const { interaction } = interactionDouble()
    const adapter = adapterDouble({
      loginKilo: async () => ({ refresh: '', access: '', expires: 0 }),
    })
    await expect(runSignIn('kilo', { interaction, adapter })).rejects.toThrow('returned no credential')
  })
})

describe('capability table', () => {
  it('supports exactly kilo and zai', () => {
    expect(Object.keys(SIGN_IN_PROVIDERS).sort()).toEqual(['kilo', 'zai'])
    expect(signInCapable('kilo')).toBe(true)
    expect(signInCapable('zai')).toBe(true)
    for (const provider of ['anthropic', 'zai-coding-cn', 'devin', 'cursor', '']) {
      expect(signInCapable(provider), provider).toBe(false)
      expect(signInProvider(provider), provider).toBeUndefined()
    }
    expect(signInProvider('zai')).toEqual({ driver: 'zai-coding-plan', label: 'Z.AI (GLM Coding Plan)' })
  })

  it('refuses a provider without a driver', async () => {
    const { interaction } = interactionDouble()
    await expect(runSignIn('anthropic', { interaction })).rejects.toBeInstanceOf(SignInUnavailableError)
  })
})

describe('bundle loading', () => {
  it('fails with a named error when the build artifact is absent', async () => {
    // Under vitest the adapter resolves `../omp-oauth/oauth.mjs` relative to
    // `src/oauth/`, where no artifact exists: this is the packaging failure a
    // published build must never have, and it must read as such.
    await expect(ompOAuthAdapter()).rejects.toBeInstanceOf(OmpOAuthBundleMissingError)
    await expect(ompOAuthAdapter()).rejects.toThrow('pnpm build')
  })
})
