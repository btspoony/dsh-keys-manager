---
category: Changed
---

- A transport account whose access token has expired but which still holds a refresh token now reads "过期（将自动续期）" / "Expired (auto-renews)" instead of "令牌已过期" / "Token expired", because those routes renew the grant on the next request and the old copy read as a demand to sign in again. A Google access token's one-hour lifetime is the token's, not the sign-in's.
