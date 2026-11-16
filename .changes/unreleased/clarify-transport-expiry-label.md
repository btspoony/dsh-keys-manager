---
category: Changed
---

- The transport account row now says what the state means: a grant whose access
  token has expired but which still holds a refresh token reads "过期（将自动续期）" /
  "Expired (auto-renews)" instead of "令牌已过期" / "Token expired". Those routes renew
  the grant on the next request, so the old copy read as a re-sign-in demand when
  none was needed. A Google access token's one-hour lifetime is the token's, not the
  sign-in's.
