---
category: Changed
---

- Moved the build-time `@oh-my-pi/*` pin from 18.18.8 to 18.20.3 and rebuilt the
  bundled transports from it; the Devin catalog now serves the single model the
  new pin lists (`swe-1-6`), and the Devin CLI identity and Factory's client
  version follow the new pin.
- Dropped the transport tests that only restated a pin measurement (per-entry
  module counts and the GitLab catalog row count); the manifest
  self-consistency, shim-surface, source-hash and artifact-size gates still pin
  the build.
