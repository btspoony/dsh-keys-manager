# Known limits

[English](known-limits.md) | [简体中文](known-limits.zh-CN.md) — Back to [README](../README.md)

Current design boundaries of the Keys Manager plugin:

- CoreWeave provider support is deferred to a later release; it is tracked in
  [issue #11](https://github.com/btspoony/dsh-keys-manager/issues/11).
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
