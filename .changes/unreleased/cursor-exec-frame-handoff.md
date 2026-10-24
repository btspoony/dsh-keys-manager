---
category: Fixed
---
- Cursor route: native `shell`/`read`/`grep`/`write` exec frames are now handed
  to DSH's tool loop instead of answered with "Tool not available" — the call
  ships unresolved, DSH executes its own `bash`/`read`/`grep`/`write` tool, and
  the result is replayed on the next request. Frames without a DSH equivalent
  (`delete`, `ls`, `diagnostics`, streamed edits) keep the previous rejection.
- The handoff translation into DSH's tool schemas is lossy: `grep`'s
  `ignoreCase`/`literal`/`context`/`offset` flags and `shell`'s timeout are
  dropped, and `shell`'s working directory is folded into the command as
  `cd <dir> && …`.
- The pinned `@oh-my-pi/pi-ai@18.12.3` is now patched via
  `patches/@oh-my-pi__pi-ai@18.12.3.patch` (`patchedDependencies` in
  `pnpm-workspace.yaml`); the cursor bundle and drift manifest were rebuilt
  together.
