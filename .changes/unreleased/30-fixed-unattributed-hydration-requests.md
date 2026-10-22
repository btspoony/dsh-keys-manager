---
category: Fixed
---
- Provider rows show an `Unattributed` count for stream attempts a route served with no account owner — whether its ownership read had not landed yet or had failed — and the count clears once a later read attributes the route. A failover retry is a new attempt, so one request can be counted more than once.
- A request waiting on ownership hydration no longer keeps the process alive for the rest of the bounded wait.
