---
category: Added
---
- New published component `dsh-llm-omp-transports` serves Cursor through DSH's LLM seam: text and reasoning deltas, usage before a single finish, finish kinds, error classification and abort.
- Tool calls are projected from DSH into the transport and unresolved calls hand off to DSH's tool loop; transport-resolved native frames are not re-dispatched.
- Cursor sign-in uses a PKCE flow with poll and refresh, and a generated 123-row model table comes from a pinned catalog.
- The install now mounts two components (the plugin detail page lists both), and the keys manager lists, activates, removes and re-authenticates the resulting Cursor accounts beside the pi-ai pool.
