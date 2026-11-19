---
category: Fixed
---
- `pnpm run build` now builds every `packages/*` component first, so a root-only build can no longer leave a stale `dsh-llm-omp-transports` artifact in place while the root looks current — a transport route kept serving the previous version's sign-in methods and model catalog.
