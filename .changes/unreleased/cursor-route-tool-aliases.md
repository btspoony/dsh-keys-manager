---
category: Fixed
---
- Fix the Cursor route's file and shell tools: DSH tools whose names collide with Cursor's native exec channel (`read`, `bash`, `write`, `delete`, `ls`, `grep`, `todo`) are advertised as `dsh_<name>` so the transport keeps them in its MCP tool list; the event stream restores the DSH name on the tool call, while history replay keeps the advertised `dsh_<name>` alias so the follow-up request matches.
