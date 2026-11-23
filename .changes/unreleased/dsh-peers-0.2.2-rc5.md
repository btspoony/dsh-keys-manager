---
category: Changed
---
- Both packages move their DSH peer cohort from `^0.2.2-rc.3` to `^0.2.2-rc.5` (harness `dsh-v0.2.2-rc.3` → `dsh-v0.2.2-rc.5`), keeping `@deepseek-ai/cordis` at `~4.1.0` and `@deepseek-ai/schemastery` at `~3.19.0`. README DSH badges follow.
- `CONTENT_REFUSED`, raised by `dsh-llm@0.2.2-rc.5` when a provider refuses the request content, is now classified as a request-shaped failure: it neither cools the key nor triggers in-request failover. Every other failure classification is unchanged.
