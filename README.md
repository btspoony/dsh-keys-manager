# DSH Keys Manager

[![npm downloads](https://img.shields.io/npm/dm/dsh-keys-manager)](https://www.npmjs.com/package/dsh-keys-manager)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](https://www.npmjs.com/package/dsh-keys-manager)
[![DSH](https://img.shields.io/badge/DSH-%5E0.2.1--rc.3-0969DA)](https://www.npmjs.com/package/@deepseek-ai/dsh-llm)

**English** | [简体中文](README.zh-CN.md)

A DeepSeek Harness plugin that turns one provider API key into a managed pool.
It extends the Models page rather than replacing it: providers, models, and the
model picker stay where they are; only the API-key source moves behind the
manager.

## What it does

**Pool and routing**

- Several keys per provider, each with an alias and a health state.
- One key pinned to a session, round-robin for new sessions; a failing request
  is retried on its key, then moved to another key.
- Exponential cooldown recovery, capped at seven days.

**Accounts and sign-in**

- Seven pi-ai OAuth providers can join the pool as an account instead of a
  pasted key.
- Two more sign in through the plugin's own bundled clients: Kilo and Z.AI
  Coding Plan.
- Seven companion transport routes for providers the vendored pi-ai cannot
  speak: Cursor, Devin, the two Google routes, Factory Droid, and the two
  GitLab Duo routes.

**Interface**

- A search-driven Keys Manager page on the plugin's own detail page.
- A "managed by Keys Manager" badge inside the existing Models provider cards.
- Extra built-in providers installed as ordinary `llm-pi-ai` routes — 35 of
  them, listed under [Provider coverage](#provider-coverage).

## Quick start

### Install

In the Desktop or Web app, open **Plugins → Add plugin**, enter `dsh-keys-manager`,
click **Install**, then **Enable now**. This installs the same published package
as the CLI path, already carrying its built bundle.

```sh
dsh plugin --profile web add dsh-keys-manager
```

One install yields both bundles, `dsh-keys-manager` and `llm-omp-transports`;
enable both — the manager owns credentials and routing, the transport the seven
routes' wire protocols. Refresh the Web page afterwards for the browser half.

<details>
<summary>Install from a local checkout</summary>

```sh
git clone https://github.com/btspoony/dsh-keys-manager
cd dsh-keys-manager
pnpm i
dsh plugin --profile web link .
```

`add` installs the published tarball with its built `lib/` and client bundle;
`link .` builds them via `prepare` during `pnpm i`, as does `prepack` when packing.

</details>

## Use it

### Take over a provider and add keys

1. Search for a provider. Open **Plugins → Keys Manager → View** (`Plugins →
   密钥管理 → 查看` in the Chinese locale); the manager renders on the plugin's
   detail page. Existing DSH providers appear first; the plugin also ships the
   curated extra catalog described under [Provider coverage](#provider-coverage).
2. Adopt a provider. For an existing provider the manager imports the
   currently resolved credential, writes a broker reference into the provider
   profile, and leaves the original key in the credential store so release can
   restore it.
3. Add more keys with an alias. Every key is stored in the Harness credential
   store under its own reference; the manager state document never contains a
   key literal.
4. Manage a key from the three-dot menu: rename, pause/resume, delete. A key
   row shows status, last use, and the recovery time while cooling.
5. Tune retry count (1–3), base cooldown, and recovery grace in the settings
   card.

### Accounts and sign-in

Providers that ship a native OAuth sign-in offer two ways to join the pool:
**Add key** stores a static API key, while **Add account** runs the provider's
OAuth sign-in flow and stores the resulting grant as an account row in the same
pool.

| Route group | How it joins | Refresh / renew |
|---|---|---|
| Seven pi-ai OAuth providers: Anthropic, GitHub Copilot, Kimi Coding, OpenAI Codex, OpenRouter, Radius, xAI | **Add account** — the provider's own OAuth flow | provider-managed refresh |
| `kilo`, `zai` (Kilo, Z.AI Coding Plan) | **Add account** through the plugin's bundled clients: device code for Kilo, a pasted redirect for Z.AI | a static credential — **Sign in again** is the only renewal |
| Seven transport routes: Cursor, Devin, the two Google routes, Factory Droid, the two GitLab Duo routes | **Transport accounts** — one grant per route | see [Transport routes](#transport-routes) |

**API keys form the selection ring** — sticky sessions, round-robin, retry
failover and cooldowns operate across the provider's keys — while **one
projected OAuth grant serves its provider**, and an account row's counters
reflect only that account's own successes and failures. Per-account ranking is
future work. When the projected grant fails, the account cools down and the
pool falls back to its keys, or stops serving on an OAuth-only route until a
manual re-login.

<details>
<summary>Sign-in flows (Kilo, Z.AI, muse-code)</summary>

- **Kilo** (`kilo`, a plugin extra route): a device-code page plus a poll; the
  first success creates the route and its first pool row, later ones append rows.
- **Z.AI (GLM Coding Plan)** (`zai`, a shipped pi-ai route): adopt it first, then
  paste the final redirect URL (a `zcode://` URL) or just the authorization code.

Both mint a **static** credential tagged `signin:kilo` / `signin:zai-coding-plan`
— **Sign in again** is the only renewal, nothing is written to
`llm-pi-ai/<provider>`, and as logins rather than transports they join the key
pool's selection, retry and cooldowns. **`muse-code` needs no transport**: the
vendored pi-ai `meta` route (`openai-responses` on `https://api.meta.ai/v1`)
serves it, the agreement check was static, and the first live call is a manual
smoke check per [Known limits](docs/known-limits.md).

</details>

### Transport routes

Providers the vendored pi-ai cannot speak are served by the companion
`dsh-llm-omp-transports` component:

- One grant per route, at `llm-omp-transports/<route>` — no key pool and no
  per-account rotation. Sign-in happens in the **Transport accounts** section of
  the Keys Manager page.
- Models are generated from the pinned `@oh-my-pi/pi-catalog@18.12.3` table when
  the transport is built, and the clients are unofficial: read the
  [transports package docs](packages/llm-omp/README.md) and its
  [known limits](packages/llm-omp/docs/known-limits.md) before relying on them.

| Route | Sign-in | Refresh | Model rows |
|---|---|---|---|
| `cursor` | browser page + poll | on the credential seam | 123 |
| `devin` | paste the landed callback URL | none — sign in again | 2 |
| `google-gemini-cli` | loopback `8085` + paste fallback | on the credential seam | 7 |
| `google-antigravity` | loopback `51121` + paste fallback | on the credential seam | 22 |
| `factory-droid` | WorkOS device code (URL + user code) | one refresh in a 60 s window, keeps `orgId`/`region` | 62 |
| `gitlab-duo` | PKCE loopback `localhost:8080/callback`, no port fallback, paste fallback | one refresh in a 60 s window | 16 |
| `gitlab-duo-agent` | paste the `vscode://` URL | one refresh, echoes the `vscode` redirect | 1 |

<details>
<summary>Per-route notes</summary>

- **Cursor** — streams text and reasoning and hands tool calls to DSH's tool
  loop; images are refused with a typed error. The client presents Cursor's
  vendor-internal OAuth identity.
- **Devin** — no refresh: a static bearer whose expiry is derived from the token
  (JWT `exp` minus five minutes, else one year), and without a readable expiry
  the row shows `active` with a blank countdown column.
- **Google routes** — both share one generated `lib/omp/google.mjs` artifact yet
  keep separate grants, account rows and catalogs. The grant is
  `{access, refresh, expires, projectId, email?}`; sign-in resolves the Cloud
  project the route bills, and a `legacy-tier` or paid account whose project
  cannot be discovered fails `AUTH_FAILED` until `GOOGLE_CLOUD_PROJECT` (or
  `GOOGLE_CLOUD_PROJECT_ID`) is set.
- **Factory Droid** — four wires behind one proxy, chosen by model id inside the
  artifact; rows carry no base URL and the account's residency
  (`orgId`/`region`) survives refresh.
- **GitLab Duo pair** — `gitlab-duo`'s direct-access token cache is keyed on the
  GitLab token, so a rotated token misses it; `gitlab-duo-agent` re-seeds a
  workflow per request and replays the transcript rather than resuming a socket.

</details>

### Selection and failure policy

| Mechanism | Behaviour |
|---|---|
| Sticky session | The first request of a session selects a key and binds it for that session/provider pair. Later requests reuse it. |
| Round robin | A new session advances the provider cursor and takes the next healthy key. |
| Retry | A failing request is retried on the same key `retryCount` times. Request-shaped failures such as `CONTEXT_WINDOW_EXCEEDED` and cancellation never cool a key. |
| Switch | After the retry budget is spent, the failing key is marked cooling, and the session is rebound to another healthy key. When no alternate key exists, the manager delegates to the composition's normal retry/fallback policy. |
| Cooldown | The first failure cools a key for `baseCooldownMs`. A failure while cooling, or within `recoveryGraceMs` after recovery, doubles the next cooldown; a long healthy gap resets the escalation. The hard cap is seven days. |
| Recovery | The key is automatically selectable again when its cooldown expires; no manual reset is required. |

## Configuration & data

Manager metadata lives at:

```text
$DSH_HOME/keys-manager/state.json
```

with owner-only permissions. It contains aliases, credential references,
health counters, session bindings, and provider adoption facts. API key
literals live only in the Harness credential store; an account row follows the
same rule behind its `grantRef`, with only non-sensitive metadata (email,
account id, expiry) in the state. The file is written atomically through a
temporary file and a rename.

Each managed provider profile points its `apiKeyEnv` at a broker reference
such as `KEYSMGR_ZAI_CODING_CN_3FA2C1`. The Host credential layer answers that
reference per request with the session's selected key. The Models page sees
the profile as configured; writing directly to the broker reference is
refused with a pointer to the manager.

<details>
<summary>OAuth2 extension point</summary>

The state shape already distinguishes `kind: "api-key"` from `kind: "oauth"`
and keeps a nullable `oauth` object beside the credential reference. A future
account flow can add records under `keys-manager/<provider>/<key>` without
rewriting existing rows. Providers whose only authentication is OAuth are
reported as unsupported in this version rather than being treated as API-key
providers.

</details>

## Provider coverage

Every provider card carries its origin:

- **DSH built-in** (`DSH 内置`) — a route from the shipped DSH pi-ai catalog.
- **Plugin built-in** (`插件内置`) — a route from this plugin's extra catalog
  in `src/providers.ts`.
- **Custom** (`自定义`) — a hand-declared route in the active profile.

The following DSH built-ins are explicitly outside single-key pool management:

| Provider | Why |
|---|---|
| `amazon-bedrock` | AWS credential chain (profile, IAM keys, ECS/IRSA/EC2), not one API key |
| `cloudflare-ai-gateway` | API key plus a Cloudflare account ID and gateway ID |
| `cloudflare-workers-ai` | API key plus a Cloudflare account ID |
| `openai-codex` | ChatGPT OAuth sign-in only; no API-key credential — usable as an [OAuth account](#accounts-and-sign-in) instead of a key |

Every other DSH catalog route exposes an API-key credential, and the
OAuth-capable ones are also usable as [accounts](#accounts-and-sign-in).

The 35 extra providers come from
[oh-my-pi](https://github.com/can1357/oh-my-pi)'s provider catalog (MIT):

<details>
<summary>All 35 extra providers</summary>

| Provider | Route id | API key env |
|---|---|---|
| DeepInfra | `deepinfra` | `DEEPINFRA_API_KEY` |
| Novita | `novita` | `NOVITA_API_KEY` |
| StepFun | `stepfun` | `STEPFUN_API_KEY` |
| SambaNova | `sambanova` | `SAMBANOVA_API_KEY` |
| Qianfan | `qianfan` | `QIANFAN_API_KEY` |
| GMI Cloud | `gmi-cloud` | `GMI_API_KEY` |
| Synthetic | `synthetic` | `SYNTHETIC_API_KEY` |
| ZenMux | `zenmux` | `ZENMUX_API_KEY` |
| Kilo Gateway | `kilo` | `KILO_API_KEY` |
| NanoGPT | `nanogpt` | `NANO_GPT_API_KEY` |
| Venice AI | `venice` | `VENICE_API_KEY` |
| AIML API | `aimlapi` | `AIMLAPI_API_KEY` |
| AI& | `aiand` | `AIAND_API_KEY` |
| Helmcode | `helmcode` | `HELMCODE_API_KEY` |
| Alibaba Coding Plan | `alibaba-coding-plan` | `ALIBABA_CODING_PLAN_API_KEY` |
| MiniMax Coding (Global) | `minimax-code` | `MINIMAX_CODE_API_KEY` |
| MiniMax Coding (CN) | `minimax-code-cn` | `MINIMAX_CODE_CN_API_KEY` |
| Umans AI Coding Plan | `umans` | `UMANS_AI_CODING_PLAN_API_KEY` |
| Sakana AI | `sakana` | `SAKANA_API_KEY` |
| CoralBricks | `coralbricks` | `CORAL_API_KEY` |
| Wafer Serverless | `wafer-serverless` | `WAFER_SERVERLESS_API_KEY` |
| Alibaba Token Plan | `alibaba-token-plan` | `ALIBABA_TOKEN_PLAN_API_KEY` |
| Alibaba Token Plan (CN) | `alibaba-token-plan-cn` | `BAILIAN_TOKEN_PLAN_API_KEY` |
| Charm Hyper | `charm-hyper` | `CHARM_HYPER_API_KEY`, `HYPER_API_KEY` |
| LiteLLM Proxy | `litellm` | `LITELLM_API_KEY` |
| SiliconFlow | `siliconflow` | `SILICONFLOW_API_KEY` |
| SiliconFlow (CN) | `siliconflow-cn` | `SILICONFLOW_CN_API_KEY` |
| Zhipu Coding Plan | `zhipu-coding-plan` | `ZHIPU_API_KEY` |
| Abliteration | `abliteration` | `ABLITERATION_API_KEY`, `ABLIT_KEY` |
| ClinePass | `cline-pass` | `CLINE_API_KEY` |
| Command Code | `commandcode` | `COMMAND_CODE_API_KEY`, `COMMANDCODE_API_KEY` |
| CoreWeave Serverless Inference | `coreweave` | `COREWEAVE_API_KEY` |
| Fire Pass | `firepass` | `FIREPASS_API_KEY` |
| Ollama Cloud | `ollama-cloud` | `OLLAMA_CLOUD_API_KEY` |
| Yolo Auto | `yolo-auto` | `YOLO_AUTO_API_KEY` |

Where two variables are listed, either is accepted; the first is the primary.

CoreWeave Serverless Inference also needs `COREWEAVE_PROJECT=<team>/<project>` in the DSH process environment before it is added.

</details>

## Documentation

| Doc | Content |
|---|---|
| [Development](docs/development.md) | build and dev workflow, repository layout |
| [Release](docs/release.md) | CI checks and the npm release flow |
| [Known limits](docs/known-limits.md) | current design boundaries, including the seven transport routes |
| [Transports package](packages/llm-omp/README.md) | Transport routes: support status, risks, build/test, release |

Chinese: [README.zh-CN.md](README.zh-CN.md) · [开发](docs/development.zh-CN.md) ·
[发布](docs/release.zh-CN.md) · [已知限制](docs/known-limits.zh-CN.md).

## License

Released under the [MIT License](LICENSE).
