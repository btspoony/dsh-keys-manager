# DSH Keys Manager

[![npm downloads](https://img.shields.io/npm/dm/dsh-keys-manager)](https://www.npmjs.com/package/dsh-keys-manager)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](https://www.npmjs.com/package/dsh-keys-manager)
[![DSH](https://img.shields.io/badge/DSH-%5E0.2.1--rc.2-0969DA)](https://www.npmjs.com/package/@deepseek-ai/dsh-llm)

**English** | [简体中文](README.zh-CN.md)

Docs: [Development](docs/development.md) · [Release](docs/release.md) · [Known limits](docs/known-limits.md) — Documentation in Chinese: [开发](docs/development.zh-CN.md) · [发布](docs/release.zh-CN.md) · [已知限制](docs/known-limits.zh-CN.md)

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

### Extra providers

`src/providers.ts` contains a curated catalog of 33 extra providers (21 from
the original catalog plus 12 added in this release, for example SiliconFlow,
Zhipu coding plan, Cline Pass, and Ollama Cloud), derived from
[oh-my-pi](https://github.com/can1357/oh-my-pi)'s provider catalog (MIT).
An extra id is added only when the shipped DSH catalog does not already
declare that route id (for example, `meta` and `typesafe` are not
duplicated); same-endpoint providers with distinct credential identities
are kept by design.

## Quick start

### Install — published package

```sh
dsh plugin --profile web add dsh-keys-manager
```

### Install — local checkout

```sh
git clone https://github.com/btspoony/dsh-keys-manager
cd dsh-keys-manager
pnpm i
dsh plugin --profile web link .
```

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
| `openai-codex` | ChatGPT OAuth sign-in only; no API-key credential |

All other DSH catalog routes expose an API-key credential. Providers that also
support OAuth (Anthropic, GitHub Copilot, Kimi, OpenRouter, xAI, Radius) remain
manageable through their API-key path; OAuth accounts are tracked separately
in the roadmap issue.

## Documentation

| Doc | Content |
|---|---|
| [Development](docs/development.md) | build and dev workflow, repository layout |
| [Release](docs/release.md) | CI checks and the npm release flow |
| [Known limits](docs/known-limits.md) | current design boundaries, including deferred providers |

Chinese versions: [README.zh-CN.md](README.zh-CN.md) and the `*.zh-CN.md`
files in `docs/`. Current design boundaries at a glance:
[Known limits](docs/known-limits.md).

## License

Released under the [MIT License](LICENSE).
