---
category: Fixed
---
- Cursor route: native `shell` (batch and streamed), `mini_swe_agent_bash`,
  `read`, `grep` and `write` exec frames are now handed to DSH's tool loop
  instead of answered with "Tool not available" — the call ships unresolved,
  DSH executes its own `bash`/`read`/`grep`/`write` tool, and the result is
  replayed on the next request. A streamed shell frame is answered with
  `start` → `rejected` → `exit 1` instead of running. Frames without a DSH
  equivalent (`delete`, `ls`, `diagnostics`, background-shell spawn/stdin,
  streamed edits) keep the previous rejection.
- The handoff translation into DSH's tool schemas is lossy: every `GrepArgs`
  refinement but `pattern`/`path`/`glob` is dropped — `caseInsensitive`,
  `contextBefore`/`contextAfter`/`context`, `offset`, `headLimit`, `multiline`,
  `sort`/`sortAscending`, `type`, `outputMode` — so a case-insensitive search
  becomes case-sensitive and a paged search returns the first page again. A
  read's embedded `:10-20`/`:raw:10-20` selector is split into `offset`/`limit`
  with the clean path. `shell`'s timeout is dropped and its working directory is
  folded into the command as a quoted `cd <dir> && …`.
- The pinned `@oh-my-pi/pi-ai@18.12.3` is now patched via
  `patches/@oh-my-pi__pi-ai@18.12.3.patch` (`patchedDependencies` in
  `pnpm-workspace.yaml`); the cursor bundle and drift manifest were rebuilt
  together.
