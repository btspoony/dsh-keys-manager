---
category: Fixed
---
- Retry pins expire after 60 seconds, and starting a new step no longer deletes another in-flight step's pin.
- Request-step records are keyed to the provider the request finally uses, and unmanaged providers are skipped before anything is recorded.
