# What the property test does and does not catch

`test/invariants.test.ts` runs randomised interleavings against a world model
and asserts invariants over the *history* of writes. This note records how it
was verified, because an untested test is worse than no test: an earlier version
of this file passed with three historical bugs reintroduced, and a later one
passed with a fourth, while reading as evidence that none of them could happen.

The verification method is mutation: reintroduce a defect, run the suite, record
what fails. The patches are in [`docs/mutations`](mutations) so a reader can
replay them:

```sh
cp src/controller.ts /tmp/c.bak && cp src/decide.ts /tmp/d.bak
python3 docs/mutations/m1.py && bun test test/invariants.test.ts
cp /tmp/c.bak src/controller.ts && cp /tmp/d.bak src/decide.ts
```

## Measured results

Every run below was repeated and gave identical failures, seed for seed. That
reproducibility is deliberate: interleavings come from a seeded PRNG, and the
store's retry backoff — which would otherwise use real timers and `Math.random`
— is injected as `retry: { sleep: async () => {}, random: () => 0.5 }` by the
test. Without that injection these numbers drifted run to run, and an earlier
version of this document printed single figures that could not be reproduced.

| Mutation | What it reintroduces | Failures |
| --- | --- | --- |
| [`m1`](mutations/m1.py) | Reconcile pre-gathers listings and hands them to each pool's pass | 16/16 freshness seeds, 8/8 convergence seeds |
| [`m2`](mutations/m2.py) | A failed runner cross-check falls through to the cooldown | 7/8 busy-runner seeds (1, 2, 3, 5, 13, 21, 34) |
| [`m3`](mutations/m3.py) | An incomplete runner listing treated as complete | 4/8 busy-runner seeds (1, 3, 8, 34) |
| [`m4`](mutations/m4.py) | Partial evidence allowed to lower a count | 8/8 busy-runner seeds |
| [`m5`](mutations/m5.py) | A future cooldown anchor trusted | the deterministic recovery case, plus 2/8 convergence seeds |
| [`m6`](mutations/m6.py) | The etag **omitted** from the scaling write, making it unconditional | 8/8 convergence seeds |
| [`m7`](mutations/m7.py) | A cached job listing reused as complete when a refresh fails | 3/16 freshness seeds, 4/8 busy-runner seeds |
| [`m8`](mutations/m8.py) | Each pool's first complete evidence cached and reused, never refetching | 5/8 convergence seeds |

Three of these are worth a note.

**`m5` is not reliably caught by randomness.** A skewed writer has to coincide
with a pool that needs lowering, and across these seeds that happens twice. The
property therefore also has a deterministic case (`banto recovers from state it
cannot trust`), which catches it every time. Where randomness does not reliably
reach a property, write the case directly and say so rather than raising the
injection rate until the number looks better.

**`m7` is why the freshness invariant compares consumed evidence.** The first
version stamped the *attempt* — that a pass called the API — which a cached
listing satisfies. It now pairs each write with the decision line that follows
it and checks the demand, the completeness and the runner view against the last
listing that controller was actually handed before that decision, **bounded to
the current pass** (every pass ends with exactly one decision line, so the
observations belonging to one are those after the previous decision). Without
that lower bound the search falls back on an earlier pass's listing, and a
controller that caches evidence and never refreshes satisfies it.

**`m8` is caught by convergence, not by freshness, and that is the division of
labour.** A controller that caches its first evidence and never looks again
stops writing once the count matches what it cached, and the freshness invariant
only examines writes that happen. A defect that *suppresses* writes is what the
convergence invariant is for.

**`m6` measures an omitted precondition, not a stale one.** An earlier version
substituted a wrong etag, which the API rejects — a much easier thing to notice.
Cloud Run treats the etag as optional, so the real risk is dropping it: the write
becomes last-writer-wins. The model therefore does two things it did not before:
its Cloud Run fake accepts an empty etag (as the API does) while refusing a stale
one, and an **external writer** — a deploy, a human with gcloud — changes the
pool between banto's read and its write. The convergence test then asserts that
no write carried an empty precondition, and that the external writer actually
fired, so the assertion is not passing for want of anything to collide with.

## What the model contains, and why

- **The clock advances** during the phase where lowering must not happen.
  Without that, the cooldown blocks every lowering and an invariant about
  evidence freshness passes without testing anything.
- **Runners exist and are idle** in the freshness phase, which makes a lowering
  as easy as possible to authorise, and **busy** in the safety phase, where no
  lowering is correct at all.
- **Listings fail and come back partial**, at configurable rates; the freshness
  phase runs a high job-failure rate, because a stale listing only does damage
  when a refresh fails.
- **Store writes fail**, and a skewed writer sometimes stores a future anchor.
- **Two or three controllers share one store and one world**, so multi-writer
  interference is present even though the deployment requires a single instance.
- **Worker pools are keyed by physical identity** and **the etag is a
  precondition**: a write with a stale etag is refused, as the API refuses it.
  Without that, dropping the precondition from the scaling write would be
  invisible to the model (`m6` measures that it is not).

## What it still cannot catch

Honest list. These need other kinds of test, or have none.

1. **Anything above the controller.** Signature verification, installation
   scoping, body limits, OIDC verification and the HTTP routes are not in the
   model; they are covered by `server.test.ts`, `signature.test.ts`,
   `oidc.test.ts` and `secrets.test.ts`.
2. **Listing *classification*.** The model's GitHub fake returns already
   classified listings, so the rules deciding whether a real response is
   complete — missing fields, `total_count` disagreements, unusable repository
   names — are covered by `listing-fuzz.test.ts` instead.
3. **Most of the client/controller boundary.** The Cloud Run fake now enforces
   the etag precondition and models an external writer, but it still returns
   instantly, never fails a read, never returns a long-running Operation that
   later reports failure, and never rejects an update for any other reason. A
   regression in how the client parses a response, retries, or reads
   `scaling.manualInstanceCount` would be caught by `cloudrun.test.ts`, not here.
4. **Two pools sharing one worker pool.** Configuration rejects it, so the model
   cannot construct it; the rejection is covered in `config.test.ts`.
5. **Real concurrency.** Interleavings come from a deterministic PRNG deciding
   how many microtasks each fake call takes. That explores orderings, not
   parallelism, and it cannot reach anything that depends on real timers, real
   sockets, or two processes.
6. **A pool above its own `max`.** The model's external writer is capped at
   `max`, so it never manufactures this state and the property layer says
   nothing about it. The behaviour is asserted directly in `controller.test.ts`
   instead: the pool is cut back to `max` once nothing is in progress and the
   runners are idle, and is held above `max` only while a job is running or
   while runner evidence is missing and the cooldown has yet to elapse.
7. **The scale-down hazard itself.** A runner picking up a job between the
   observation and the PATCH is not a bug the model can distinguish from correct
   behaviour, because it is not a bug — it is the documented limitation. The
   invariants are written to tolerate it, which means they also cannot detect a
   change that made the window *wider*.
8. **Rate-limit exhaustion and its knock-on effects.** Failures are injected as
   independent per-call probabilities; a real exhaustion is correlated across
   every call for an hour, and nothing here models that.
9. **Store semantics beyond compare-and-set.** The model's store is the
   in-memory one wrapped in failures. Firestore and GCS behaviours — a
   precondition rejected for a reason other than a conflict, a generation that
   does not advance — are covered only by their own unit tests.
