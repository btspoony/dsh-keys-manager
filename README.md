# DSH Keys Manager

A DeepSeek Harness plugin that turns one provider API key into a managed pool:

- several keys per provider, each with an alias and health state;
- one key pinned to a session, with round-robin selection for new sessions;
- bounded retry on the same key, then automatic failover to another key;
- exponential cooldown recovery, capped at seven days;
- a search-driven Keys Manager page on the plugin's own detail page;
- a "managed by Keys Manager" badge inside the existing Models provider cards;
- extra built-in providers installed as ordinary `llm-pi-ai` routes.

The plugin extends the Models page rather than replacing it. Providers, models, and the model picker stay where they are; only the API-key source moves behind the manager.

## Install

From the repository root, build the TypeScript sources first:

```sh
pnpm install
pnpm build
```

Then install the linked package:

```text
plugin_manager install_bundle dsh-keys-manager@link:/absolute/path/to/dsh-keys-manager
```

The `name@link:` form is the local-directory spec pnpm 12 accepts. The package
manifest points the Host at `lib/index.js`, the Client at `lib/client.js`, and
the bundle patch at `bundle/cordis.patch.yml`. Refresh the Web page after
installing so the browser half is fetched.

## Use

Open **Plugins → 密钥管理 → 查看** (or **Plugins → Keys Manager → View**).
The manager renders on the plugin's detail page, between its description and
its included rows, matching the shipped plugin configuration cards.

1. Search for a provider. Existing DSH providers appear first; the plugin also
   ships a curated extra catalog (DeepInfra, Novita, StepFun, Synthetic,
   ZenMux, Kilo, NanoGPT, MiniMax Coding, Umans, and others).
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

## Data

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

## Extra providers

`src/providers.ts` contains a curated catalog derived from
[oh-my-pi](https://github.com/can1357/oh-my-pi)'s provider catalog (MIT). An
extra provider is installed by writing a complete `llm-pi-ai` profile:

```yaml
providers:
  deepinfra:
    displayName: DeepInfra
    api: openai-completions
    baseURL: https://api.deepinfra.com/v1/openai
    apiKeyEnv: KEYSMGR_DEEPINFRA_...
    models: [...]
```

The Host asks the adapter to discover the endpoint's models first; when
discovery is unavailable or blocked, the seed catalog is installed instead.
Releasing an extra provider that the manager created removes the whole route
profile, so the Models page returns to its previous state.

## Provider classification

Every provider card carries its origin:

- **DSH 内置 / DSH built-in** — a route from the shipped DSH pi-ai catalog.
- **插件内置 / Plugin built-in** — a route from this plugin's extra catalog in
  `src/providers.ts`.
- **自定义 / Custom** — a hand-declared route in the active profile.

The following DSH built-ins are explicitly outside single-key pool management:

| Provider | Why |
|---|---|
| `amazon-bedrock` | AWS credential chain (profile, IAM keys, ECS/IRSA/EC2), not one API key |
| `cloudflare-ai-gateway` | API key plus a Cloudflare account ID and gateway ID |
| `cloudflare-workers-ai` | API key plus a Cloudflare account ID |
| `openai-codex` | ChatGPT OAuth sign-in only; no API-key credential |

All other DSH catalog routes expose an API-key credential. Providers that also
support OAuth (Anthropic, GitHub Copilot, Kimi, OpenRouter, xAI, Radius) remain
manageable through their API-key path; OAuth accounts are tracked separately
in the roadmap issue.

## OAuth2 extension point

The state shape already distinguishes `kind: "api-key"` from `kind: "oauth"` and
keeps a nullable `oauth` object beside the credential reference. A future
account flow can add records under `keys-manager/<provider>/<key>` without
rewriting existing rows. Providers whose only authentication is OAuth are
reported as unsupported in this version rather than being treated as API-key
providers.

## Source map

| File | Role |
|---|---|
| `src/index.ts` | Host plugin: credential broker, selection, failover, settings writes, Remote namespace |
| `src/core.ts` | Pure round-robin, cooldown, status, and validation policy |
| `src/store.ts` | Secret-free durable state and atomic writer |
| `src/providers.ts` | Extra built-in provider catalog |
| `src/domain.ts` | Shared Host/Client domain shapes |
| `src/client/index.ts` | Client registration on the plugin-detail and Models slots |
| `src/client/ui.ts` | Manager page, key rows, forms, and Models badge |
| `src/client/store.ts` | Client snapshot store and RPC calls |
| `tests/core.test.ts` | Policy and store tests |
| `tests/host.test.ts` | Host service, adoption, failover, and secret-free persistence tests |
| `tests/client.test.ts` | Registration, locale parity, and client store tests |

## Development

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

`pnpm build` runs the Node-side `tsc` build (`lib/`), emits the Client
declarations, bundles the Client with esbuild, and verifies every artifact the
package manifest resolves. `pnpm test` runs the Vitest suites.

The Host half is a normal ESM Cordis function plugin. The Client half is a
normal slot plugin; `scripts/build-client.mjs` wraps it in the
`window.__ModuleLoader__.load` closure only at bundle time, so the source is
importable by tests.

## Release

CI (`.github/workflows/ci.yml`) runs typecheck, build, tests, and a packed
tarball assertion for `lib/index.js`, `lib/client.js`, and
`bundle/cordis.patch.yml`.

Releases are PR-driven:

1. Actions → **Release prep** → Run workflow. Leave the version empty for an
   automatic patch bump, or pass `X.Y.Z` / `X.Y.Z-prerelease`.
2. The workflow bumps `package.json`, updates `CHANGELOG.md` from git log,
   validates the build, and opens a `release v<version>` PR.
3. Merge the release PR. The **Release** workflow publishes
   `dsh-keys-manager@<version>` to npm with provenance, pushes tag
   `v<version>`, and creates the GitHub Release.

npm publishing uses OIDC trusted publishing (no `NPM_TOKEN`). Configure a
Trusted Publisher for this repository and the `Release` workflow on npmjs.com
before the first release. Prerelease versions publish to a prerelease dist-tag
and never move `latest`.

The Release prep workflow opens its PR with `GITHUB_TOKEN`. If the repository
disables Actions-created PRs, enable **Settings → Actions → General → Allow
GitHub Actions to create and approve pull requests**, or point the workflow at
a fine-grained PAT secret instead.

## Known limits

- OAuth2 account pools are designed for but not implemented. Anthropic key
  pools manage a plain `ANTHROPIC_API_KEY`; its OAuth/federation token paths
  are not account pools.
- Cloudflare AI Gateway and Workers AI require a Cloudflare account ID (and a
  gateway ID for AI Gateway) in addition to the API key. They are reported as
  unsupported key pools and should be configured natively in Models.
- Provider-native cloud credential chains (for example an AWS profile used by
  a Bedrock route) are not split into per-key rows; those providers are shown
  with an explanatory reason unless they also expose an API-key variable.
- A release restores the profile's `apiKeyEnv`, but other provider edits made
  by the user in Models are preserved.
- Cooldown counters are local to this Harness home; they are not shared
  between hosts.
