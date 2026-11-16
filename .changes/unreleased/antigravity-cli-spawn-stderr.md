---
category: Fixed
---

- Fixed Antigravity sign-in failing immediately with "Antigravity CLI sign-in failed;
  try signing in again": the bundled `Bun.spawn` stand-in returned no `stderr`
  stream, so reading the CLI's output threw before the authorization page could be
  shown. A piped stderr is now exposed, as Bun reports it, and ignored stdio stays
  undefined.
