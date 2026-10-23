---
category: Fixed
---
- Fix the Cursor route's file and shell tools: DSH tools whose names collide with Cursor's native exec channel (`read`, `bash`, `write`, `delete`, `ls`, `grep`, `todo`) are advertised as `dsh_<name>` so the transport keeps them in its MCP tool list, and an aliased call is mapped back to the DSH name on the event stream and in history replay.
