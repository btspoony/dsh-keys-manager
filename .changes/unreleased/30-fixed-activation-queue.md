---
category: Fixed
---
- Activating an account no longer holds the global mutation queue while it reads the OAuth credential, so a slow credential store cannot delay unrelated key or settings changes; the activation's errors, returned state and cooldown reset are unchanged.
- An activation now writes its credential projection only while the route still serves the value it read, and never deletes a grant another writer replaced. A rejected state flush puts the projection back — removing it only when the activation created it — so a refused activation leaves nothing behind.
- A refused activation restores the route's owner classification along with the projection it puts back, so requests keep using the restored credential and failures keep attributing to it instead of falling back to the key pool; the activated account keeps its claim whenever its projection is still serving.
