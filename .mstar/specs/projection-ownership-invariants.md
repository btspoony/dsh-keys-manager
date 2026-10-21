# Projection ownership invariants

Cross-iteration engineering rules for the `llm-pi-ai/<provider>` projection that the keys
manager owns. Promoted from iteration `iter-2026-Q4-pool-truth` (plans `iter-pool-hydration` and
`iter-pool-activate-queue`), where both rules were established by implementation, QC tri and a
mutation-checked regression each.

These are constraints on *any* future code that reads, writes or removes a projection record or
the owner claim beside it. They are not a description of the current implementation; they are the
conditions that implementation has to keep satisfying.

## 1. Attribution is decided per provider, and its absence is observable

- Readiness is a **per-provider** fact. A provider whose ownership read has landed is ready, with
  or without an owner; a provider whose read failed stays unready, and every later request for it
  is served **without** spending the wait budget.
- The pass that reads every managed provider must settle with `Promise.allSettled`, never
  `Promise.all`: with `all`, one rejecting task settles the awaited pass early, the pass-level
  `finally` flips the "hydration over" flag while other reads are still in flight, and requests
  for those providers are then attributed from an incomplete map. The guard is structural today —
  no task body can reject, because the read error is caught inside the task and every later call
  is guarded by the payload predicate — and it must stay that way until a real rejection path
  exists with a test that pins its consequence.
- A request served without an owner is **accounted**, per provider, and the count clears only
  when a read actually decides the route's attribution. Counting in the hydration failure path
  instead of the per-request serving path counts events, not requests.

## 2. A queue window owns state, a per-provider chain owns credentials

- The mutation queue turn is the only place that may write manager state, and `buildState` belongs
  inside it: it is not a pure read (it prunes bindings/attempts and destructively drains warnings).
- Credential read → projection write → owner claim → broker binding sync belong on the
  **per-provider reconciliation chain**, which is also where rotation and the reconcile echo run.
  Holding the queue across credential I/O stalls unrelated mutations.
- Splitting the two creates windows the single turn used to close, and each needs an explicit
  fence:
  - **Shutdown**: every `await` in a chain body re-checks closing/persistence refusal and the
    remount epoch. A body resumed after the drain deadline returns without writing or claiming.
  - **Removal**: a removal runs on the queue, not the chain, so the body proves the row is still
    managed before projecting, and compensates after writing.
  - **Post-commit refusal**: a refusal *after* the chain committed must roll back, and only what
    this activation proves it owns: withdraw the claim only on exact generation + account
    identity, delete the record only through the delete authority's payload proof, and treat an
    **unprovable** identity (`unknown`) as permission for nothing.
  - **Identity**: resolve rows by id, and compare the projection by the `grantRef` this activation
    wrote. Row-object identity and "the row exists" are both insufficient — a same-id row can be
    re-created inside one `syncBrokerBinding` window.

## 3. Evidence rules that made these rules hold

- Every fence above has a case that **fails without it**; the removal-race case is the exception
  and must say so — the old single-turn code already serialised it, so it guards the new design
  rather than reproducing a defect.
- Mutations must disable the whole set of guards on the asserted path at once, or isolate one
  guard per run: removing one while another still covers the same hole leaves the suite green and
  the green is false confidence.
- A `set -o pipefail`-less pipeline reports the tail's status, not the compiler's or the runner's.
  Every recorded exit code must come from the pipeline.

## References

- `src/index.ts` — hydration pass, wait/readiness, `wrapStream` attribution, mutation queue,
  per-provider chain, delete authority (`decideAndDeleteProjection`), activation split
- Iteration package: `.mstar/iterations/iter-2026-Q4-pool-truth/delivery-compass.md` (D13, D14,
  D17 and the plans' contracts)
- Residuals that remain open and constrain these rules: `I-000200`, `I-000201`, `I-000203`,
  `I-000206`
