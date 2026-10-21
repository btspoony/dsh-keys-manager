---
category: Fixed
---
- Provider rows show an `Unattributed` count for requests a route served with no account owner — whether its ownership read had not landed yet or had failed — and the count clears once a later read attributes the route.
- The startup ownership read settles with `Promise.allSettled`, so one provider's failed read can no longer report the other routes as ready before their own reads land.
- A request waiting on ownership hydration no longer keeps the process alive for the rest of the bounded wait.
