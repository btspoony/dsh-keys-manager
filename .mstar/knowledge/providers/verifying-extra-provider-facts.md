# Verifying extra provider facts before adding a plugin built-in route

Adding a curated API-key provider to `src/providers.ts` (`EXTRA_PROVIDERS`) is
data-only, but every fact must survive scrutiny: a wrong `baseURL` or env name
ships a broken route to every user who adopts it. This is the verification
workflow proven across the issue #2 Phase 1 additions (12 providers, 2026-10-19).

## Sources, in trust order

1. **oh-my-pi catalog** (MIT, the upstream this catalog is curated from):
   - `https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/catalog/src/models.json` — per-provider model groups with `api`, `baseUrl`, context windows.
   - `https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/providers.md` — env var table (the tiebreaker when the issue table and docs disagree, and vice versa: record which won).
2. **models.dev** (`https://models.dev/api.json`) — seed-model cross-check when the bundled catalog lacks models (e.g. SiliconFlow): limits, modalities.
3. **Provider's own docs / live endpoint** — env var name, default base URL, and a live `GET /v1/models` or `/api/tags` when the above are silent (charm-hyper, ollama-cloud).
4. **The installed DSH catalog** — the dedup authority. See below.

## Non-negotiable gates

- **Protocol gate**: DSH pi-ai supports only `openai-completions`,
  `openai-responses`, `anthropic-messages`. oh-my-pi also uses `ollama-chat`
  and proprietary protocols (typesafe/SystemOne). If the provider's oh-my-pi
  carrier is not one of DSH's three, find an official OpenAI-compatible
  endpoint (ollama-cloud: `https://ollama.com/v1` per docs.ollama.com) or skip
  the provider — never add a route whose protocol DSH cannot serve.
- **DSH exposure check (dedup gate)**: before adding an id, check whether the
  installed DSH chat catalog already declares it. The catalog lives in the
  installed `@deepseek-ai/dsh-llm-pi-ai` package's `lib/index.js` (a ~90 KB
  bundle whose provider table is greppable). Calibrate the grep with a route
  the plugin's own tests prove is served (e.g. `zai-coding-cn`, which
  `tests/host.test.ts` shows with `origin: 'dsh'`), then grep the candidate id
  (`"typesafe": {`, `"meta": {`). Both checks are id-level; `meta` is a short
  string, so grep a route-id-shaped occurrence, not the bare word.
- **Header contract**: `src/providers.ts` states the dedup caliber (route-id
  level; same-endpoint entries with distinct credential identities allowed —
  precedents `alibaba-token-plan`/`qwen-token-plan(-individual)` and
  `zhipu-coding-plan`/`zai-coding-cn`) and the layout rule (addition batches,
  alphabetical within a batch). Read it before adding; keep it true.
- **Seed fidelity**: transcribe seeds verbatim from the cited source. If the
  source documents one model, ship one model — never pad to a band. Declare
  `input` modalities exactly as the source records them (a wider declaration
  offers image input a text-only endpoint will reject). Seeds are fallback-only;
  runtime discovery overrides them, which bounds but does not excuse
  transcription errors.

## Process notes

- Cite per-entry sources in the commit body; the review package only carries
  subject lines, so the commit body is the durable provenance record.
- `pnpm test -- <file>` does not filter under vitest v4 (runs all unit files);
  use `pnpm exec vitest run tests/host.test.ts` for strict file scope.
- In sandboxed environments where `web_fetch` rejects fake-IP DNS, shell
  `curl` through the same proxy works and its output can be quoted as evidence.
- The `llm-pi-ai` profile this plugin writes (`{displayName, api, baseURL,
  apiKeyEnv, models}`) has no header carrier: providers needing extra headers
  (coreweave's `COREWEAVE_PROJECT`) are deferred until a carrier exists
  (btspoony/dsh-keys-manager#11).
