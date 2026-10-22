---
category: Fixed
---
- The transport model picker fails closed when the settings store cannot be read: it reports the read error with a Retry action and keeps Save disabled, instead of showing the all-models state whose one save would have cleared a narrowed selection; a stored model id the shipped catalog no longer offers is filtered out of the picker so the remaining selection still saves.
