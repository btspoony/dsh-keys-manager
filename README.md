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

## Features

- Several keys per provider, each with an alias and health state.
- One key pinned to a session, with round-robin selection for new sessions.
- Bounded retry on the same key, then automatic failover to another key.
- Exponential cooldown recovery, capped at seven days.
- A search-driven Keys Manager page on the plugin's own detail page.
- A "managed by Keys Manager" badge inside the existing Models provider cards.
- Extra built-in providers installed as ordinary `llm-pi-ai` routes.
- OAuth account sign-in for seven pi-ai-backed providers, stored beside
  the API keys.
- A companion transport component for providers the vendored pi-ai cannot
  speak — seven routes: Cursor (`cursor`), Devin (`devin`), Google Gemini CLI
  (`google-gemini-cli`), Google Antigravity (`google-antigravity`), Factory
  Droid (`factory-droid`), GitLab Duo (`gitlab-duo`) and GitLab Duo Agent
  (`gitlab-duo-agent`) — installed with the plugin.

### Extra providers

This catalog of 35 extra providers comes from
[oh-my-pi](https://github.com/can1357/oh-my-pi)'s provider catalog (MIT).

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

## Quick start

### Install — DeepSeek Harness Desktop / Web

In the DeepSeek Harness Desktop or Web app, open **Plugins**, click
**Add plugin**, enter `dsh-keys-manager` in the package field, and click
**Install**. When the install finishes, choose **Enable now** so the plugin is
switched on.

Through the wizard, the app installs the same published npm package as the
CLI path below, already carrying its built bundle. Refresh the DeepSeek
Harness page afterwards so the browser half is fetched.

### Install — published package

```sh
dsh plugin --profile web add dsh-keys-manager
```

Installing `dsh-keys-manager` installs two bundle components. The published
package depends on `dsh-llm-omp-transports`, so one install resolves both npm
packages, and the plugin page lists both `dsh-keys-manager` and
`llm-omp-transports`. Enable both: the manager owns credentials and routing,
the transport component owns the wire protocols of its seven routes (Cursor,
Devin, the two Google routes, Factory Droid, and the two GitLab Duo routes).

### Install — local checkout

```sh
git clone https://github.com/btspoony/dsh-keys-manager
cd dsh-keys-manager
pnpm i
dsh plugin --profile web link .
```

The two CLI paths differ in where the build output comes from: `dsh plugin
--profile web add dsh-keys-manager` installs the published npm tarball, which
ships the built `lib/` and the client bundle. The local
`dsh plugin --profile web link .` path runs `prepare` during `pnpm i`, which
builds `lib/` and the client bundle, so the clone flow above includes that
build step; `prepack` builds the same output when the package is packed or
published.

Refresh the Web page after installing so the browser half is fetched.

## Usage

Open **Plugins → Keys Manager → View** (rendered as
`Plugins → 密钥管理 → 查看` in the Chinese locale). The manager renders on the
plugin's detail page, between its description and its included rows, matching
the shipped plugin configuration cards.

1. Search for a provider. Existing DSH providers appear first; the plugin also
   ships the curated extra catalog described above.
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

### OAuth accounts

Providers that ship a native OAuth sign-in offer two ways to join the pool:
**Add key** stores a static API key, while **Add account** runs the
provider's OAuth sign-in flow and stores the resulting grant as an account
row in the same pool.

Supported providers — the seven whose OAuth flows `llm-pi-ai` implements:
Anthropic, GitHub Copilot, Kimi Coding, OpenAI Codex, OpenRouter, Radius,
and xAI.

The increment-1 model is honest about scope: **API keys form the selection
ring** — sticky sessions, round-robin, retry failover, and cooldowns
operate across the provider's API keys — while **one projected OAuth grant
serves its provider**: the account whose grant is projected answers
requests directly, and one active grant per provider is kept. Per-account
ranking (rotating or load-balancing between accounts) is future work. An
account row's counters reflect that account's own successes and failures,
not a per-account traffic split. When the projected grant fails (expired
or refresh rejected), the account cools down. On a key-capable route the
pool falls back to the provider's key pool; an OAuth-only route has no
API-key pool and stops serving requests until an account is signed in
again. Recovery is a manual re-login from the account menu.

Adding an account stores only the provider-issued grant in the Harness
credential store, behind the account's `grantRef`; the manager state keeps
the reference plus non-sensitive metadata (email, account id, expiry) — the
same secret-free layout as API keys.

### Sign-in providers (Kilo, Z.AI Coding Plan)

Two more routes sign in from Keys Manager through this plugin's own bundled
clients instead of the `llm-pi-ai` seam:

- **Kilo** (`kilo`, installed as a plugin extra route): a device-code page
  plus a poll. The first successful sign-in creates the route and its first
  pool row; later sign-ins append rows.
- **Z.AI (GLM Coding Plan)** (`zai`, a shipped pi-ai route): adopt it first.
  The flow opens a browser page and asks you to paste the final redirect URL
  (a `zcode://` URL) or just the authorization code back into the dialog.

Both mint a **static** credential — a token or an `id.secret` key — stored as
an ordinary pool row tagged `signin:kilo` / `signin:zai-coding-plan`. They are
not refreshable grants, so the row menu's **Sign in again** is the only way to
renew one; it replaces that row's literal in place and keeps its id and
position. Nothing is written to `llm-pi-ai/<provider>` for these routes.

**A login flow is not a transport.** These two routes serve through the normal
pi-ai key pool and take part in sticky selection, round-robin, retry failover
and cooldowns. The `llm-omp-transports` surface described below is the other
thing entirely: one grant per route, each with its own section.

**`muse-code` needs no transport.** It is already served by the vendored pi-ai
`meta` route (`openai-responses` against `https://api.meta.ai/v1`, catalog key
`meta`), so it is managed through the ordinary pi-ai provider path. The check
that the catalog entry and the provider agree on that route and credential
shape was static; no live request was made. The first live call is a manual
smoke check, as described in [Known limits](docs/known-limits.md).

### Cursor transport

Cursor is served by the companion `dsh-llm-omp-transports` component on its
own `cursor` route. It does not run through the pi-ai key pool: the route
keeps exactly one grant at `llm-omp-transports/cursor`, refreshed
automatically on the credential seam.

- Models come from the pinned `@oh-my-pi/pi-catalog@18.12.3` table (123 rows),
  generated into the transport at build time. The route streams text and
  reasoning, and hands tool calls to DSH's tool loop.
- Sign in from the **Transport accounts** section of the Keys Manager page: a
  browser page plus a poll. The row shows identity, expiry and status; after an
  expired or rejected grant, re-login is manual.
- Images are not forwarded yet. The route advertises text-only input and
  refuses image blocks with a typed error instead of dropping them.
- The client is unofficial and presents Cursor's vendor-internal OAuth
  identity. Read the [transports package docs](packages/llm-omp/README.md)
  before relying on it; the risks and limits are listed there.

### Devin transport

Devin is the second route served by the same `dsh-llm-omp-transports`
component, on its own `devin` route with the same one-grant record at
`llm-omp-transports/devin`.

- Sign in from the **Transport accounts** section. omp finishes this login
  through a loopback listener that only Bun provides, so this plugin opens the
  authorize page and asks you to paste back the address the browser landed on
  (the full URL or `code#state`). Nothing listens on the redirect port, so the
  page itself fails to load and the code stays in the address bar.
- **There is no refresh.** The record is a static bearer whose expiry is
  derived from the token (JWT `exp` minus five minutes, else one year). A
  grant with no `expires` is served as a static bearer and reported `active`
  with no expiry time and no countdown (the column stays blank); once a
  readable expiry passes, sign in again by hand.
- Models come from the pinned catalog (two rows, `swe-1-6` and `swe-1-6-fast`)
  generated into the transport at build time.
- The client is unofficial and presents the released Devin CLI identity; the
  real endpoints and protocol behavior are unverified. Read the
  [transports package known limits](packages/llm-omp/docs/known-limits.md)
  before relying on it.

### Google transports

Two Google routes are served by the same `dsh-llm-omp-transports` component.
They share one generated `lib/omp/google.mjs` artifact and the provider inside
it dispatches on the model, but each route is separate everywhere else:
`google-gemini-cli` and `google-antigravity`, each with its own one-grant
record at `llm-omp-transports/<route>`, its own account row and its own model
catalog.

- Sign in from the **Transport accounts** section. This login finishes in the
  plugin itself: a `node:http` listener on `127.0.0.1` receives the browser
  redirect (`8085` `/oauth2callback` for `google-gemini-cli`, `51121`
  `/oauth-callback` for `google-antigravity`, with a free-port fallback when
  the default is taken). The same dialog always offers the paste path — the
  full address the browser landed on, or `code#state` — for a browser that
  cannot reach the listener.
- The grant is `{access, refresh, expires, projectId, email?}` and refreshes
  on the credential seam, so an expired token is renewed without re-login
  while the refresh token stays valid. Sign-in also resolves the Google Cloud
  project the route bills and sends.
- Models come from the pinned catalog at build time: seven rows for
  `google-gemini-cli`, 22 for `google-antigravity`.
- The clients are unofficial and present vendor-internal OAuth identities; the
  first live turn on either route is a manual smoke check. Read the
  [Known limits](docs/known-limits.md) for the listener, the antigravity
  version read and the 401/403 posture before relying on them.

### Selection and failure policy

- **Sticky session**: the first request of a session selects a key and binds
  it for that session/provider pair. Later requests reuse it.
- **Round robin**: a new session advances the provider cursor and takes the
  next healthy key.
- **Retry**: a failing request is retried on the same key `retryCount` times.
- **Switch**: after the retry budget is spent, the failing key is marked
  cooling, and the session is rebound to another healthy key.
- **Cooldown**: the first failure cools a key for `baseCooldownMs`. A failure
  while cooling, or within `recoveryGraceMs` after recovery, doubles the
  next cooldown. A long healthy gap resets the escalation. The hard cap is
  seven days.
- **Recovery**: the key is automatically selectable again when its cooldown
  expires; no manual reset is required.
- **Delegation**: request-shaped failures such as
  `CONTEXT_WINDOW_EXCEEDED` and cancellation never cool a key. When no
  alternate key exists, the manager delegates to the composition's normal
  retry/fallback policy.

## Configuration & data

Manager metadata lives at:

```text
$DSH_HOME/keys-manager/state.json
```

with owner-only permissions. It contains aliases, credential references,
health counters, session bindings, and provider adoption facts. API key
literals live only in the Harness credential store. The file is written
atomically through a temporary file and a rename.

Each managed provider profile points its `apiKeyEnv` at a broker reference
such as `KEYSMGR_ZAI_CODING_CN_3FA2C1`. The Host credential layer answers that
reference per request with the session's selected key. The Models page sees
the profile as configured; writing directly to the broker reference is
refused with a pointer to the manager.

### OAuth2 extension point

The state shape already distinguishes `kind: "api-key"` from `kind: "oauth"`
and keeps a nullable `oauth` object beside the credential reference. A future
account flow can add records under `keys-manager/<provider>/<key>` without
rewriting existing rows. Providers whose only authentication is OAuth are
reported as unsupported in this version rather than being treated as API-key
providers.

## Provider classification

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
| `openai-codex` | ChatGPT OAuth sign-in only; no API-key credential — usable as an [OAuth account](#oauth-accounts) instead of a key |

All other DSH catalog routes expose an API-key credential. Providers that
also support OAuth (Anthropic, GitHub Copilot, Kimi Coding, OpenAI Codex,
OpenRouter, Radius, xAI) remain manageable through their API-key path, and
their OAuth sign-in is available as [OAuth accounts](#oauth-accounts).

## Repository layout

This repository is a pnpm workspace with two published packages:

| Path | npm package | Role |
|---|---|---|
| root | `dsh-keys-manager` | Host plugin, Keys Manager Web client, bundle patch |
| `packages/llm-omp` | `dsh-llm-omp-transports` | Cursor, Devin and Google transport component |

The root package declares the transports package as a dependency, so the
published Keys Manager tarball pulls the transport in rather than vendoring
it. Both packages are released together and carry the same version; see
[Release](docs/release.md).

## Documentation

| Doc | Content |
|---|---|
| [Development](docs/development.md) | build and dev workflow, repository layout |
| [Release](docs/release.md) | CI checks and the npm release flow |
| [Known limits](docs/known-limits.md) | current design boundaries, including the seven transport routes |
| [Transports package](packages/llm-omp/README.md) | Transport routes: support status, risks, build/test, release |

Chinese versions: [README.zh-CN.md](README.zh-CN.md) and the `*.zh-CN.md`
files in `docs/` — [开发](docs/development.zh-CN.md) ·
[发布](docs/release.zh-CN.md) · [已知限制](docs/known-limits.zh-CN.md).
Current design boundaries at a glance:
[Known limits](docs/known-limits.md).

## License

Released under the [MIT License](LICENSE).
