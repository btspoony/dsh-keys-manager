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
- The handoff translation into DSH's tool schemas is lossy: `grep`'s
  `ignoreCase`/`literal`/`context`/`offset`/`skip` flags and `shell`'s timeout
  are dropped (a paged `grep` request collapses to the first page instead of
  advancing), and `shell`'s working directory is folded into the command as a
  quoted `cd <dir> && …`.
- The pinned `@oh-my-pi/pi-ai@18.12.3` is now patched via
  `patches/@oh-my-pi__pi-ai@18.12.3.patch` (`patchedDependencies` in
  `pnpm-workspace.yaml`); the cursor bundle and drift manifest were rebuilt
  together.
