# Known limits

[English](known-limits.md) | [简体中文](known-limits.zh-CN.md) — Back to [README](../README.md)

Current design boundaries of the Keys Manager plugin:

- CoreWeave Serverless Inference resolves `COREWEAVE_PROJECT` (the
  `<team>/<project>` pair) from the DSH process environment at add time and
  stores it as a static `OpenAI-Project` header on the route profile, so
  requests keep sending the project that was set when the provider was added.
  To change it, release the provider from Keys Manager first, then restart
  DSH with the new value and add the provider again. Release removes the
  `OpenAI-Project` value this plugin wrote while it still equals the current
  environment value; a value it cannot attribute is kept and reported in the
  UI warnings, and a hand-written header that happens to equal the
  environment value is removed by the same rule. A profile the plugin created
  is removed and recreated on the next add, while an adopted profile is kept
  and re-adopted; in both cases the plugin only fills a declared header the
  profile does not already carry and never overwrites a stored value.
- OAuth2 account pools ship as increment 1 for seven pi-ai-backed providers;
  see the OAuth accounts limits below. Anthropic key pools still manage a
  plain `ANTHROPIC_API_KEY` — its OAuth/federation token paths are separate
  account rows, not key-pool members.
- Cloudflare AI Gateway and Workers AI require a Cloudflare account ID (and a
  gateway ID for AI Gateway) in addition to the API key. They are reported as
  unsupported key pools and should be configured natively in Models.
- Provider-native cloud credential chains (for example an AWS profile used by
  a Bedrock route) are not split into per-key rows; those providers are shown
  with an explanatory reason unless they also expose an API-key variable.
- A release restores the profile's `apiKeyEnv`, but other provider edits made
  by the user in Models are preserved. Releasing an extra provider whose route
  profile the plugin created removes that route, including later edits; the
  confirmation text says so.
- Cooldown counters are local to this Harness home; they are not shared
  between hosts.
- Retry identity is ambient: retry pins and request steps are recorded per
  session and provider, not per HTTP request. When several steps of the same
  session and provider run concurrently, a retry stream may fail to consume
  its own pin, or a finishing step may clear another step's pin. A direct
  stream without a `purpose` may also consume one pending retry pin while its
  window is open. The pin window is 60 seconds, which bounds this exposure
  but does not eliminate it; concurrent multi-step retry behavior remains
  best-effort.

## OAuth accounts (increment 1)

- Account sign-in is limited to the seven providers whose OAuth flows the
  `llm-pi-ai` host implements: Anthropic, GitHub Copilot, Kimi Coding,
  OpenAI Codex, OpenRouter, Radius, and xAI. Extending coverage through an
  oh-my-pi extension is tracked in
  [issue #15](https://github.com/btspoony/dsh-keys-manager/issues/15).
- Grant refresh failure is fail-loud: the account cools down. A
  key-capable route falls back to the provider's key pool; an OAuth-only
  route has no API-key pool and stops serving requests until an account is
  signed in again. Re-authentication is manual —
  re-login from the account menu.
- Only one active grant per provider is kept.
- Conditional delete is a credential-seam capability this plugin does not
  have: the store offers `deleteRecord(key)` with no compare/version guard,
  so demoting or compensating the `llm-pi-ai/<provider>` projection is a
  decide-then-delete pair. A native grant written in the sub-microtask window
  between the final comparison and the delete's queue entry can therefore be
  deleted even though it no longer belongs to the account being removed. The
  manager narrows the window (a compare inside the seam's per-key lock plus a
  pre-delete re-read) and a regression test pins the residual exactly. The
  upstream capability request is store issue I-000090 (credential seam:
  compare-and-delete / versioned delete primitive).
- Increment 1 keeps the selection model key-centric: the provider's API
  keys form the sticky/round-robin/failover/cooldown ring, and exactly one
  projected OAuth grant serves the provider. Per-account ranking
  (rotating between accounts) is future work, not part of this increment.
