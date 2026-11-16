---
category: Fixed
---

- Sign-in to `google-gemini-cli` now asks for the Google Cloud project id in the
  sign-in panel when Google will not discover one for a Workspace/GCA or paid
  account, instead of failing until `GOOGLE_CLOUD_PROJECT` is exported and the
  host restarted; the two environment variables still answer the question up
  front.
