---
category: Added
---
- Extra providers can declare environment-sourced request headers; values are read from your environment when the provider is added and refused loudly when missing, blank or credential-bearing.
- `coreweave` joins the catalog through that carrier with `COREWEAVE_API_KEY` and `COREWEAVE_PROJECT` for its `OpenAI-Project` header, and providers with declared headers use their seed catalog instead of model discovery.
- Changing the environment later surfaces as a state warning, and removing the provider drops only the header value it set.
