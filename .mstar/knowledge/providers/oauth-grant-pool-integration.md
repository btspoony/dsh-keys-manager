# Integrating an OAuth account pool with the DSH authorization and credential seams

Proven across dsh-keys-manager Phase 2 increment 1 (7 pi-ai OAuth providers, 2026-10-19). The pattern lets a plugin manage a pool of OAuth accounts (multi-account, rotation, cooldown, fallback to API keys) without writing any OAuth protocol code.

## The core trick: activation projection (D1)

pi-ai resolves route auth per request as **stored credential first, `apiKeyEnv` second**. So a plugin cannot serve accounts through `apiKeyEnv` — it must manage the **`llm-pi-ai/<provider>` grant record itself**:

- Account grant payloads (the pi-ai `OAuthCredential` shape: `refresh`/`access`/`expires` + identity) live under the **plugin's own scope** (`keys-manager/<provider>-<hexhash>`; credential-key charset is `/^[a-z][a-z0-9-]*$/` — no underscores, no digit-leading segments).
- The currently-selected account is **projected** into `llm-pi-ai/<provider>` via `ctx.credentials.modifyRecord` — the seam's lock (cross-process file lock + re-read-before-write) provides CAS. There is no scope-ownership enforcement on `modifyRecord` (verified against `packages/credentials/credentials/src/index.ts:22,69-76,236-250`), but treat cross-scope writes as a deliberate, documented contract: validate the payload shape before writing and reconcile on events.
- **Key-pool fallback = `deleteRecord('llm-pi-ai/<provider>')`** — resolution then falls through to the ambient env (the broker reference). Re-activation writes the grant back.

## Staying out of pi-ai's way (single-writer discipline)

pi-ai is the single writer of its records (login and lazy per-request refresh both go through `credentials.modify`). Rules that kept the pool consistent:

- **Rotations are authoritative**: when `credentials/record-updated` fires for the projection key, sync the rotated payload back into the owning account's plugin-scope record (metadata AND payload — a metadata-only sync silently re-projects stale refresh tokens on re-activation; found by QC).
- **Owner resolution must survive refresh-token rotation**: hashing `payload.refresh` orphans the row when a provider rotates refresh tokens. Re-associate by provider + identity metadata (accountId first with an `accountId === undefined` guard on the email fallback — same-email/different-account dual rows otherwise mis-attribute), then re-point `grantRef` and write the payload back.
- **Echo suppression needs a TTL, not a microtask**: the real store emits `record-updated` for your own `deleteRecord` too, and async reads reorder events. A one-shot boolean lost the race; a `Map<key, markedAt>` with a ~5s TTL consumed by the echo handler is robust.
- **Cleanup symmetry**: every path that removes/rotates an account must delete the superseded plugin-scope record (re-login with a new refresh token, remove, release) — otherwise secret-bearing orphans accumulate in the credential store forever.

## Driving login headlessly (D3)

`ctx.authorization.begin({key: <flowKey>, method: 'oauth', interaction, signal})` — the flow key is `llm-pi-ai/<provider>` (pin it in a test against `packages/llm/llm-pi-ai/src/login.ts`). The caller supplies the `AuthorizationInteraction{notify,prompt}`; a web plugin bridges it over two typert endpoints (`beginAccountLogin` returns an attempt id; `answerAccountPrompt` resolves pending prompts — direct invocation is single-value, so prompts need the second endpoint or a streaming channel). Harvest on `authorization/settled`: read the grant from the projection record, persist it under the account's plugin-scope ref, upsert the account row. Failures/cancellations/timeouts must finalize the attempt with a reason AND reject any pending prompt (a wedged prompt holds the seam's per-key single-flight slot).

## Failure semantics to design around

pi-ai refresh is **lazy per-request and fail-loud** (`ModelsError` with an oauth/auth code, no env fallback, no reauth state machine). Treat refresh failures as ordinary pool failures: cooldown the account, fall back to keys, offer manual re-login. Unknown failure codes already default to failover via `shouldFailover` — pin both the observed and the documented code strings in tests so upstream wording changes surface as test failures, not silent misclassification.

## What to not build

- No proactive refresh scheduler (pi-ai's lazy model suffices; omp's lease+CAS machinery is the reference only if multi-process robustness is ever needed).
- No custom per-provider login UI per protocol — one interaction bridge serves all flows; provider differences live upstream.
