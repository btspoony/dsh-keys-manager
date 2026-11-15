---
category: Changed
---
- Both packages move their DSH peer cohort from `^0.2.2-rc.1` to `^0.2.2-rc.3` (harness `dsh-v0.2.2-rc.1` → `dsh-v0.2.2-rc.3`), keeping `@deepseek-ai/cordis` at `~4.1.0` and `@deepseek-ai/schemastery` at `~3.19.0`.
- `@deepseek-ai/dsh-error` joins the declared peers of both packages, because `dsh-llm@0.2.2-rc.3` moved `HarnessError` into it and now declares it as a peer.
- Transport errors carrying provider-neutral codes are raised through the rc.3 `LlmError.fromFailure` path; the emitted error codes, messages, causes and provider facts are unchanged, and neither the session format nor the storage format moved.
