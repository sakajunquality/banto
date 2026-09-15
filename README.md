# banto

**banto** (番頭 — the head clerk who staffs a shop as trade demands) keeps a
[Cloud Run worker pool](https://cloud.google.com/run/docs/deploy-worker-pools)
staffed with ephemeral GitHub Actions self-hosted runners. It listens to
`workflow_job` webhooks, counts the jobs that want each pool, and moves the
pool's `manualInstanceCount` to match.

Automatic scale-down is disabled by default to protect running jobs. Capacity
can grow but is retained after work finishes. Opt into `scaleDown: "idle"` only
if the [documented interruption risk](#the-scale-down-hazard) is acceptable.

It is a single Bun process with one runtime dependency (Hono), deployed as a
container built with [bunko](https://github.com/sakajunquality/bunko). It must
run as **exactly one instance** — see
[why](#running-as-a-single-instance).

```
GitHub ──workflow_job──▶ POST /webhook ─┐
                                        ├─▶ demand per pool (GCS) ─▶ Cloud Run Admin API
Cloud Scheduler ─OIDC──▶ POST /reconcile┘      (manualInstanceCount)
```

## Why this exists

A Cloud Run worker pool does not scale itself. The v2 API's scaling settings
for a worker pool are a single field, `manualInstanceCount` — there is no
automatic mode, no target utilisation, and no minimum or maximum for the
platform to move between. Whatever the count is, it stays there until something
sets it.

That leaves the count to be set by something outside the pool, and the
interesting question is what that something should watch. Not CPU. A runner
that is idle — registered with GitHub, long-polling for a job — uses almost no
CPU, and it is exactly the instance you want to keep or add. A runner that is
busy is already committed to a job; adding a sibling because its CPU is high
does not help the job it is running, and removing it because a compile step
went quiet is actively harmful. CPU measures what a runner is doing, and what
matters is what is waiting.

The signal that matters is the GitHub job queue, and GitHub reports it directly.
Every `workflow_job` webhook says which job entered the queue, which one started
running, which one finished — and it carries the `labels` that say which kind of
runner the job asked for. That is demand, per pool, in real time. banto turns it
into an instance count.

So the pool stays in `MANUAL` mode and banto is the thing that does the scaling,
because it is the thing that can see the queue.

## How it works

A **pass** is the unit of work, and it is stateless:

1. Ask GitHub what is queued and running for this pool right now.
2. Ask GitHub which runners are registered for it and whether any is busy.
3. Ask Cloud Run what the pool's instance count is.
4. Decide `desired = clamp(demand + warmSpare, min, max)` and write it, if it
   differs from what is there.

**Demand is computed, never accumulated.** banto keeps no set of tracked job
ids, no tombstones for jobs that finished, no counters for a backlog it stopped
tracking. Earlier versions did, and every one of those needed a rule for merging
a partial, point-in-time observation into an accumulated model — what to do with
a duplicate delivery, a reordered one, a listing that raced a webhook, a job
whose completion arrived twice. The merge rules were where the bugs were. There
is nothing to merge into now: the answer to "what is queued for this pool" is
whatever GitHub says when asked.

**Webhooks are triggers, not data.** A `workflow_job` delivery means "something
changed for this pool, look again". Its labels choose the pool; the rest of the
payload is discarded. That costs a listing round trip on the scale-up path,
which is a few hundred milliseconds against a container start measured in tens
of seconds — and it buys the deletion of the entire class of merge bugs above.

**The one safety rule.** Evidence that might be partial — a truncated listing, a
failed call, an unreachable API, a row with a field missing — can raise a count
but never lower one. A truncated job listing looks exactly like an idle queue,
so banto treats "I could not see everything" as "I may not shrink this pool".

That rule is carried by the type rather than by a flag everyone has to remember
to check: evidence is either the complete variant or the partial one, and the
fields a lowering decision needs (how many jobs are running, what the runners
say) **exist only on the complete variant**. A row banto cannot read fully — a
job with no labels, a runner with no `busy` flag, a repository name it cannot
safely put in a URL — makes the whole listing partial.

`total_count` is treated asymmetrically, on purpose:

- a count banto **cannot read** (a string, a negative, a fraction) makes the
  listing partial, because it can no longer tell whether it saw everything;
- a count **larger** than the rows fetched makes it partial: rows are missing;
- a count that **changes between pages** makes it partial, whichever way it
  moved: membership changed while banto was reading, and it cannot tell which
  row moved. The larger count is the one kept, so an earlier page's evidence
  that something was missing is not erased by a later page reporting fewer.

A cross-check that was never configured is the one thing that is *not* missing
evidence: with no `runnerRepo` on the pool and no `GITHUB_ORG` for the
deployment, there is no runner list to read, and a pool can still be scaled
down on the cooldown. A cross-check that was configured and failed blocks the
lowering, because the runner it could not read might be the busy one.

### Matching jobs to pools

Each pool has a label selector. A job belongs to a pool when every label in the
selector is present on the job (matching is case-insensitive, like GitHub's
own). A job that matches no pool is ignored. When several pools match, **the most
specific selector wins** — the one with the most labels — because a narrower
selector is the more deliberate statement about where the job should run; a tie
is broken by the order the pools appear in `BANTO_POOLS`, so the result is
deterministic and a human can fix it by reordering.

### Scaling up

On the next pass, with no smoothing or cooldown in the way: a pass that finds
more work than instances patches the pool immediately.

"Next pass" is not "instantly", and the difference is worth knowing. A delivery
that arrives while a pass is running joins the queued follow-up, and a pass will
not start until `BANTO_MIN_PASS_INTERVAL_SECONDS` (default 10) have passed since
the previous one — so a webhook arriving just after a pass finishes waits almost
the whole interval before anything is fetched. Worst case is therefore about one
interval plus the listing time. Set the interval to 0 if you want the lowest
possible latency and can afford the API calls; against a Cloud Run instance that
takes tens of seconds to become a registered runner, ten seconds of scheduling
delay is usually not where the time goes.

### Scaling down

Each pool supports `scaleDown: "disabled"` (the default) or `"idle"`.
`disabled` prevents banto from requesting any decrease, including from a count
above `max`, while still allowing scale-up for demand or `min`. Capacity is
retained and billed until retired through a separate operational procedure.
Use this when controller-initiated interruption is unacceptable. It cannot
undo an earlier accepted PATCH or prevent platform failures and external writes.

**Upgrade behavior:** configurations written before this option existed now
retain capacity. Explicitly set `scaleDown: "idle"` to keep the previous
mitigation policy. This default changes cost and scale-to-zero behavior, not
the configured scale-up bounds.

In `idle` mode, banto only scales a pool down when **all** of these hold:

- **The evidence is complete.** A listing that was truncated or could not be
  fetched may not lower a count.
- **No job for this pool is running**, according to that listing.
- **No runner for this pool is `busy`**, when the runner list is available. This
  is GitHub's own statement about the machines that would be stopped.
- **The idle cooldown has passed** (`cooldownSeconds`, default 300). Online
  idle runners do not bypass it. Any queued/running job, busy runner, or
  incomplete observation restarts the anchor. With a positive cooldown, surplus
  capacity is deliberately retained until work drains, including capacity above
  `max` set by another actor. Setting the cooldown to zero opts out of this grace.
- **A second fresh observation still permits the reduction.** Before a downward
  PATCH, banto fetches jobs, runners and the worker-pool count again and records
  that observation. New work or incomplete evidence cancels the reduction;
  failures reading the pool or writing state fail the pass without shrinking.

A missing or unreadable anchor — a failed state write, a corrupt value — reads
as **busy just now**, not as busy never. The conservative direction costs one
cooldown of capacity; the other direction scales a pool away on the strength of
having no record of it.

A failed pass can also leave an old, readable anchor behind. banto resets it
on the next successfully recorded observation. Every controller startup does
the same, because the previous process may have observed work without saving
it. With a positive cooldown, recovery and restart therefore cost a fresh grace
period; scale-up is still immediate. These are observation-based mitigations,
not proof that the pool was continuously idle between polls.

Read the next section before you set `min: 0` on anything that matters.

## The scale-down hazard

**Reducing a worker pool's instance count can stop an instance that is running a
job.** Cloud Run decides which instance to stop. The
[worker-pool scaling API](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.workerPools#WorkerPoolScaling)
accepts an aggregate count, with no termination target or runner-drain
acknowledgement. It cannot express "remove this retired runner and keep that
busy runner". Cloud Run's separate Instances API is not a retirement selector
for a worker pool's count update.

What `--ephemeral` does and does not buy you is worth being precise about. It
guarantees that a runner takes one job and deregisters after processing it. It
does not establish that an unused runner cannot accept its first job during
scale-down, or that a killed runner's registration immediately disappears. It says
nothing about how the interrupted job is reported: GitHub notices the runner is
gone on its own schedule, and the job's failure can take minutes to surface. So
the job is lost either way — the guarantee is about the *runner*, not about
prompt feedback.

Everything in the section above reduces the odds. **None of it eliminates them.**
banto's evidence is always at least a few seconds old: a runner that reported
`busy: false` during a pass can have picked up a job before the PATCH lands.
That window is small, it is not zero, and no amount of care on this side of the
API can close it.

**Ignoring termination is not a drain protocol.** A runner that refuses to exit, or holds
a lease while it works, does not survive a scale-down: Cloud Run sends `SIGTERM`
and follows it with `SIGKILL` about ten seconds later, and an instance being
removed is removed whatever the process inside it does. Ignoring the signal buys
ten seconds, not a graceful finish. Coordinating admission with retirement needs a separate design; see
[the coordinated-retirement design](docs/runner-retirement.md) for
[Issue #7](https://github.com/sakajunquality/banto/issues/7).
Available mitigations include:

- **`scaleDown: "disabled"`** — prevents new downward requests by banto while
  retaining scale-up. This is containment, with a continuing capacity cost.
- **`min`** — a capacity floor, not protection for any particular instance.
  A reduction from two to one can still terminate the busy runner.
- **The runner cross-check** plus the mandatory cooldown and pre-PATCH
  confirmation reduce the opportunity for stopping a newly busy runner.
- **A generous `cooldownSeconds`** retains capacity between closely spaced jobs.
  It now applies even when online runners report idle, and work or incomplete
  evidence restarts it. It is a mitigation, not an admission barrier.
- **Short jobs.** The exposure is proportional to how long a job runs: a
  four-minute job spends far less of its life eligible to be stopped than a
  forty-minute one.
- **Accepting the failure mode**: a stopped instance fails its job, and someone
  re-runs it. `gh run rerun --failed`, or the re-run button, is the remedy.
  Note what is *not* a remedy: `continue-on-error` performs no retry at all. It
  marks the failed job as tolerated, so the workflow can report success while
  the job it was validating never ran — on a release pipeline that is worse than
  the failure it hides.

If automatic capacity reclamation must also avoid intentionally interrupting
jobs, use an execution architecture with individual runner lifecycles. The
[design investigation](docs/runner-retirement.md#alternative-execution-architecture)
describes that alternative and the requirements for a pool-wide barrier.

## Reconcile

`POST /reconcile` (for Cloud Scheduler) runs a pass for every pool, whether or
not a delivery arrived. It is not conceptually different from a webhook-triggered
pass — both compute from the same sources — but it is what makes banto correct
when deliveries are missed, duplicated, delayed or dropped entirely: a lost
webhook costs one scheduling interval, not a permanently wrong instance count.

A reconcile where any pool's pass failed answers `500` with the per-pool errors,
so Cloud Scheduler retries rather than recording a success.

It does **not** share a listing between pools, even though the jobs API is not
per-pool and one listing would answer for all of them. Anything shared would
have to be fetched before the pools queued behind one another, and would then
age while they waited — which is the bug class this design exists to remove. The
cost is one observation per pool, plus a second for a proposed reduction,
and it is accounted for below.

The same rule holds for the runner listing, including when several pools
declare the same `runnerRepo`: each pool's pass still asks that endpoint on its
own, for the identical reason — an answer fetched for one pool and handed to
the next would be stale by the time the next pool's pass acts on it. Sharing
a repository does not make its runners' state any less able to change between
two pools' passes.

### The runner cross-check

Each pass reads a runner listing and matches the rows to pools by their labels,
exactly the same selector logic as jobs. Which endpoint depends on where that
pool's runners register:

- **`runnerRepo` set on the pool** — `GET /repos/{owner}/{repo}/actions/runners`.
  Use this when the runner registration token was minted for a repository
  rather than the org, which is a property of how the runner image registers,
  not of banto. Getting this wrong looks like nothing at all: the org endpoint
  answers with an empty list rather than an error, so a pool checked at the
  wrong scope reads as "zero runners", indistinguishable from a genuinely dead
  pool until you already suspect the endpoint.
- **`runnerRepo` unset** — `GET /orgs/{org}/actions/runners` (set `GITHUB_ORG`),
  as before. This is still the right default for an installation whose runners
  register to the org.

The App needs **Organization -> Self-hosted runners: read** for the org form,
or **Administration: read** on the repository for the repo form. Note that the
repo form is *not* covered by `Actions: read`: GitHub's own description of
`GET /repos/{owner}/{repo}/actions/runners` is "authenticated users must have
admin access to the repository", which for an App is the Administration
permission. An App that mints runner registration tokens already holds the
write version of it. That one call answers two questions
the job queue cannot:

- **Are the instances actually becoming runners?** banto compares each pool's
  instance count with the number of *online* runners carrying its labels. A brief
  shortfall is normal — an instance takes tens of seconds to register — so banto
  remembers when the shortfall started and only escalates when it persists for
  five minutes:

  ```json
  {"severity":"ERROR","message":"worker pool instances are not becoming runners","pool":"default","instances":3,"runnersRegistered":0,"runnersOnline":0,"runnersBusy":0,"shortfall":3,"sustainedForSeconds":420}
  ```

  That is a bad App key, an image that cannot be pulled, or a crash loop. Without
  this check it was invisible: banto would raise the count, log a satisfied
  `scale_up`, and the jobs would sit in the queue with nothing to say why.

- **Is anything actually running right now?** `busy` is reported per runner. A
  busy runner blocks a scale-down outright, and a pool whose online runners are
  all idle must still wait out the cooldown and pass the final confirmation.

The observation is used by the pass that fetched it and is not kept afterwards.

What happens when it is missing depends on *why*:

- **Neither `runnerRepo` nor `GITHUB_ORG` is set** — the cross-check is not
  configured, which is a deployment choice rather than a gap. The pass falls
  back to the cooldown.
- **The call failed, or the listing was truncated** — that is missing evidence.
  The pass may raise a count but not lower one, and it will keep refusing to
  lower for as long as the failures persist. A pool cannot shrink while banto
  cannot see its runners. This is also what an unsafe `runnerRepo` produces,
  should one ever reach the client — config rejects the shape at startup, so
  this is a defense that should never fire, not a documented way to disable
  the check.

### What it costs, and the knobs that bound it

A proposed scale-down performs two full observations rather than one, including
a second worker-pool GET and state update. Budget up to twice the listing cost
below on those passes. Scale-up and unchanged passes use one observation.

Every pass fetches its own evidence — job listings, the runner listing and the
Cloud Run count — after it has claimed the pool's slot and waited out the
interval floor. Nothing is shared between pools, because anything shared would
have to be gathered before the pools queued behind one another, and would then
age while they waited. The cost of that safety is arithmetic worth doing before
you deploy.

A pass for one pool costs:

```
  pages(repositories)                                      only when GITHUB_REPOS is unset
+ pages(queued_runs) + pages(in_progress_runs)             per repository, minimum 2
+ pages(jobs_in_run)                                       per active run
+ pages(runners)                                           once, minimum 1

  where pages(n) = floor(n / 100) + 1
```

Two things surprise people here. Pagination: one repository with four active
runs of 250 jobs each is `2 + 4x3 + 1 = 15` calls, not 7. And `pages(n)` has
that shape rather than `ceil(n / 100)` because a full page is followed by one
more request to discover that the next page is empty — exactly 100 runs costs
two calls, not one. Leaving `GITHUB_REPOS` unset adds the installation
discovery pages on top, at least one per pass.

A GitHub App installation's rate limit is 5,000 requests an hour at minimum
(more for large organisations), so at the default ten-second floor — 360 passes
an hour per pool — that single repository costs 5,400 calls an hour for one
pool, which is already over the floor.

Three knobs, in the order they help:

- **`GITHUB_REPOS`.** The per-pass cost is dominated by the repository count, so
  narrowing the scope is by far the most effective lever.
- **`BANTO_MIN_PASS_INTERVAL_SECONDS`.** Doubling it halves the spend. The cost
  is scale-up latency, bounded by the same number.
- **Fewer pools per deployment**, since each pool runs its own passes.

Work out `passes_per_hour x calls_per_pass x pools` against your installation's
limit and leave headroom, or read it off the logs instead of computing it: every
`x-ratelimit-*` header banto sees updates one shared counter — there is exactly
one GitHub client for the whole process, however many pools are configured —
and once per reconcile sweep banto reports what it says:

```json
{"severity":"DEBUG","message":"GitHub API budget","remaining":3120,"limit":5000,"percentRemaining":62.4,"resetAt":"2026-09-13T15:00:00.000Z","consumedSincePreviousReport":420}
{"severity":"WARNING","message":"GitHub API budget is running low","remaining":850,"limit":5000,"percentRemaining":17,"resetAt":"2026-09-13T15:00:00.000Z"}
{"severity":"ERROR","message":"GitHub API budget is nearly exhausted","remaining":120,"limit":5000,"percentRemaining":2.4,"resetAt":"2026-09-13T15:00:00.000Z"}
```

`consumedSincePreviousReport` is the delta against the last time this printed
anything, not against the start of this sweep — a webhook-triggered pass
between two reconciles spends the same shared budget and belongs in the same
figure — and it is omitted once the hourly window rolls over, so a reset is
never misread as budget regained. The severity mirrors the staffing alarm's
shape on purpose: routine is DEBUG, tight enough to look at is WARNING at 20%
remaining, and close enough to plausibly hit zero before the window resets is
ERROR at 5% — the same practical failure as a staffing outage, since nothing
can be scaled up either way. This is reported once per reconcile regardless of
how many pools are configured, not once per pool: the counter is already
installation-wide, so printing it from inside each pool's own pass would
multiply one shared number by the pool count instead of just stating it.

Exhaustion itself still degrades safely regardless of whether anyone is
watching the logs: listings fail, the evidence is partial, and no pool is
scaled down — though none is scaled up either, which is the failure you are
budgeting to avoid.

## Running as a single instance

**banto must be deployed as one instance**, and the reason is worth stating
because the obvious alternative looks like it should work.

Two instances would need to agree on who may write a pool's instance count. A
distributed lock is the usual answer, and it buys nothing here: a lock is only as
good as the fencing token the protected resource checks, and Cloud Run's `etag`
is not one. An applier that stalls past its lease, resumes, re-reads a *fresh*
etag and writes its stale count will succeed — the API has no way to know its
authority expired. There is no correct version of that design at this layer, so
banto does not pretend to have one.

With one instance, serialising passes per pool inside the process is sufficient
and obviously so, and that is all banto does. Passes are cheap in wall-clock
terms and coalesce under load, so one process handles a CI organisation's
delivery rate comfortably.

Configure it at the **service** level, not the revision template:

```hcl
scaling {
  max_instance_count = 1
}
```

`template.scaling.max_instance_count` is per *revision*, so setting it there
still permits two revisions to run an instance each. Keep 100% of traffic on the
latest revision too: a traffic split holds two revisions serving indefinitely,
which is the one configuration that makes concurrent appliers permanent rather
than momentary.

Even with both of those set, more than one instance can exist: a rollout
overlaps old and new revisions, and a revision that is *tagged* and addressed
directly serves outside the traffic split and does not count against the
service-level maximum. Keep exactly one serving revision — no splits, no tagged
revisions taking traffic — and treat any period with two as a period when banto
is not exclusive.

banto does not assume exclusivity in any case. A pass writes what its own
observation implies, and if another instance wrote something different, the next
pass on either side recomputes from GitHub and corrects it. The guarantee is:

> **banto converges on the correct instance count. It does not guarantee that
> every intermediate write was correct.**

## Observability

- `GET /healthz` — unauthenticated, for the platform's own probes.
- Every decision is one structured JSON log line:

```json
{"severity":"INFO","message":"scaling decision","pool":"default","demand":2,"warmSpare":0,"current":1,"desired":2,"target":2,"outcome":"scale_up","wrote":true,"evidence":"complete","running":0}
{"severity":"INFO","message":"scaling decision","pool":"default","demand":1,"warmSpare":0,"current":2,"desired":1,"target":2,"outcome":"blocked_in_progress","wrote":false,"evidence":"complete","running":1}
{"severity":"INFO","message":"scaling decision","pool":"build","demand":0,"warmSpare":0,"current":1,"desired":0,"target":0,"outcome":"scale_down","wrote":true,"evidence":"complete","running":0,"runnersOnline":1,"runnersBusy":0,"idleEvidence":"cooldown"}
{"severity":"INFO","message":"scaling decision","pool":"build","demand":0,"warmSpare":0,"current":1,"desired":0,"target":1,"outcome":"blocked_incomplete_evidence","wrote":false,"evidence":"partial","evidenceReason":"runner listing unavailable"}
```

`outcome` is one of `scale_up`, `scale_down`, `unchanged`,
`blocked_incomplete_evidence`, `blocked_in_progress`, `blocked_runner_busy`,
`blocked_cooldown`, `blocked_scale_down_disabled`. `idleEvidence` is now `cooldown` for every scale-down;
older releases also emitted `runners` for the removed idle-runner shortcut.

**A configured pool that never matches a job looks, in the logs, exactly like a
healthy idle one** — a 200 for every webhook, no error, no counter. That was
true right up until it wasn't: five pools' worth of drifted labels went
unnoticed this way until the symptom (scaling decisions only ever appearing at
reconcile time, never from a webhook) was tracked down by hand. Each pool's
pass now remembers how long it has been since it last matched anything at all,
and says so once that has gone on for a day:

```json
{"severity":"WARNING","message":"pool has matched no job in an extended window","pool":"build","labels":["self-hosted","runner-build"],"idleForSeconds":90000}
```

A day is deliberately long. banto cannot tell "these labels drifted from the
runner pool's real `runner_labels`" apart from "this pool genuinely has no
traffic today" — a nightly-only pool is exactly as healthy as a broken one by
this measure — so the threshold is chosen to sit above ordinary quiet rather
than to prove drift, and the line lands at WARNING rather than ERROR because
banto is reporting an absence, not a confirmed failure.

Only passes that gathered complete evidence count toward the window. A partial
pass reports whatever demand it managed to count, which is zero when the
listing failed outright — and zero there means banto could not finish looking,
not that there was nothing to find. Letting that advance the window would blame
a drifted selector for an outage, and would do it during the outage. A pool
whose listings stay partial therefore never reaches the warning, which is the
honest answer: nothing established that it matched nothing.

The window is tracked in memory, not in the store (see [State](#state)): a
restart costs a delayed report, never a wrong scaling decision, so it was not
worth a third persisted value.

**The other direction — a job whose labels match no configured pool at all —**
is logged at DEBUG per event, unchanged, because most installations see this
constantly for ordinary GitHub-hosted jobs (`ubuntu-latest` and the like)
alongside anything that might be real drift, and a single event cannot tell
the two apart. What is new is a summary once per reconcile sweep, of what
arrived and matched nothing since the last one:

```json
{"severity":"INFO","message":"jobs matched no configured pool since the last reconcile","total":9,"distinctLabelSets":3,"bySignature":[{"labels":"windows-latest","count":5},{"labels":"ubuntu-latest","count":2},{"labels":"runner-ghost,self-hosted","count":2}]}
```

This stays at INFO regardless of the count: a high number on its own is not a
problem on an installation that also runs GitHub-hosted jobs through the same
webhook, and only a human who knows their own workflows can tell a drifted
pool selector from ordinary traffic. Escalating this on volume or persistence
alone would be a warning that cries wolf on most installations, so it does
not try — it only makes the pattern visible where before there was nothing
above DEBUG to notice it by. Only webhook deliveries feed this count, not the
job listings each pool's own pass fetches: those are already scoped per pool
and fetched once per pool rather than once for the installation (see
[Reconcile](#reconcile)), so folding them in here would either double-count a
job several pools' listings happened to include, or require an installation-
wide listing this design deliberately does not take.

Secrets are kept out of the logs deliberately, though this is a discipline
rather than a guarantee the type system enforces: no token, signature or private
key is logged, and **no upstream response body is repeated** — not truncated,
not summarised, not through a parse error's message, and not through a
repository name that arrived from the API. A test plants a marker in every
response shape banto can receive and asserts it never surfaces in an error or a
log line; a new call site that interpolated something it should not would have
to get past that test.

## Authentication

| Endpoint | Who calls it | How it is protected |
| --- | --- | --- |
| `POST /webhook` | GitHub | `X-Hub-Signature-256` HMAC over the raw bytes, **plus** an installation check |
| `POST /reconcile` | Cloud Scheduler | Google-signed OIDC ID token, verified in-process against an allowlist |
| `GET /healthz` | probes | nothing |

### The webhook

The signature is computed over the exact bytes GitHub sent. (Decoding the body
to a string and re-encoding it is not a round trip — invalid UTF-8 collapses to
U+FFFD, so two different bodies can hash alike.) An unsigned request is rejected
before the body is read at all, and the body is capped and read against a
deadline.

**A valid signature is not authorization.** GitHub signs every installation's
events with the same webhook secret, so if anyone else installs the same App,
their `workflow_job` events arrive correctly signed. banto therefore requires
the payload's `installation.id` to equal `GH_APP_INSTALLATION_ID`, and rejects
everything else with a 403. `GITHUB_REPOS`, if set, additionally restricts which
repositories may drive scaling.

### The reconcile

**Why banto verifies the ID token itself instead of relying on Cloud Run IAM.**
`/webhook` has to be reachable by GitHub, which carries no Google identity, so
the service is deployed with `--allow-unauthenticated`. Cloud Run IAM is a
property of the *service*, not of a path: once the service is public, every path
on it is public, and `roles/run.invoker` protects nothing. The only place left
to check who is calling `/reconcile` is inside the process. banto verifies the
RS256 signature against Google's published JWKS, requires `iss` to be Google,
requires `aud` to equal `BANTO_RECONCILE_AUDIENCE`, checks `exp`/`iat` with a
small skew, and requires the caller's verified `email` to be on
`BANTO_RECONCILE_ALLOWED_EMAILS`.

That allowlist is **required**, not optional. An audience is a name, not a
permission: any Google principal can mint a token for any audience, so without
an allowlist "verified" would mean no more than "signed by Google". banto
refuses to start without one. Key lookups are throttled too, so a
stream of forged tokens with unknown key ids cannot be turned into a stream of
requests to Google.

Because banto does the verification, the audience is just a string both sides
agree on — it does not have to be the service URL, which conveniently avoids a
Terraform dependency cycle between the service and the scheduler job.

There is no mode in which banto skips this check. Splitting the service in two —
a public one for `/webhook`, a private one for `/reconcile` behind
`roles/run.invoker`, sharing one state bucket — would look like an alternative
and is not one: both services mount both routes, and two deployments sharing a
bucket are two permanent concurrent appliers, which is exactly what
[running as a single instance](#running-as-a-single-instance) rules out.

## State

banto persists two numbers per pool, and only because they cannot be recomputed
from a single observation:

- `lastBusyAt` — when a pass last saw work, a busy runner, or incomplete evidence. The
  idle cooldown counts from it, and no API call answers "when was this pool last
  busy".
- `shortfallSince` — when instances first outnumbered online runners and have
  ever since. That is a duration across passes, not a fact about one.

Everything else a decision needs is read in the pass that uses it. The instance
count comes from Cloud Run, demand and runners come from GitHub. That is what
makes the store this small, and it is the same reason there are no merge rules
to get wrong.

The controller separately keeps a little bookkeeping **in memory, not in the
store**, purely to know what to log: how long it has been since a pool last
matched a job (see [Observability](#observability)), a running tally of jobs
that matched no pool, and the last GitHub rate-limit reading it printed. None
of it is read by `decide()`, so losing it on a restart costs a delayed or
reset report, never a wrong scaling decision — which is the bar a third stored
value would have to clear, and this bookkeeping does not, so it stays out of
the store and out of the schema.

The store is behind a small interface with optimistic concurrency:

```ts
interface DemandStore {
  get(key: string): Promise<{ state: PoolState; version: string | null }>;
  put(key: string, state: PoolState, expectedVersion: string | null): Promise<...>;
}
```

- **GCS** (default, `BANTO_STORE=gcs`): one small JSON object per pool. Reads
  take the object generation from the media download's own `x-goog-generation`
  header — one request, no metadata call — and writes send it back as
  `ifGenerationMatch`, with `0` meaning "only if absent". A lost race is a 412,
  which becomes a retry on fresh state. Cloud Storage has been strongly
  consistent for reads and writes since 2020.
- **Firestore** (`BANTO_STORE=firestore`): one document per pool, with
  `currentDocument.updateTime` as the same optimistic lock.
- **In-memory** (`BANTO_STORE=memory`): for tests and local runs. It logs a
  warning at startup, because it loses the cooldown anchor on every restart —
  and a restart is ordinary: a new revision, a scale to zero, a crash. A lost
  anchor reads as "busy just now", so the cost is a pool that holds its
  instances for one extra cooldown after each restart, not one that sheds them
  early.

The compare-and-set matters whenever two instances exist at once — a rollout, or
a tagged revision taking traffic. In the intended steady state there is one
writer, by deployment requirement.

**Why GCS is the default.** The honest trade is that Firestore is a little
faster per operation and GCS is far easier to provision. banto writes two
numbers per pass, so the latency difference does not show up in anything an
operator would notice; the provisioning difference does. "Create a bucket" is
one resource anyone can add to an existing project. Enabling Firestore is a
project-level decision with a database mode attached to it, in a project that
may already have made a different one. Both are supported and the code above the
store cannot tell which one it is talking to.

## Configuration

Everything comes from the environment and is validated at startup. An invalid
configuration prints *every* problem it found and exits 78 (`EX_CONFIG`) rather
than failing on the first webhook of the day. That covers structure and
loadability — the GitHub App key is parsed at startup, for instance, so a
placeholder in the secret fails immediately — but it cannot tell you that a
well-formed credential is the *wrong* credential, or that a pool name exists.
Those surface on first use.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `BANTO_POOLS` | yes | — | JSON array of pool objects, see below |
| `GITHUB_WEBHOOK_SECRET` | yes | — | Shared secret configured on the GitHub App webhook |
| `GH_APP_ID` | yes | — | GitHub App ID |
| `GH_APP_INSTALLATION_ID` | yes | — | Installation ID; events from other installations are rejected |
| `GH_APP_PRIVATE_KEY` | yes | — | PEM private key; `\n` escapes are accepted |
| `GITHUB_REPOS` | no | installation's repos | Comma-separated `owner/repo` list: reconcile scope *and* webhook allowlist |
| `GITHUB_ORG` | no | — | Org whose runner registrations the reconcile cross-checks, for pools without their own `runnerRepo` |
| `BANTO_STORE` | no | `gcs` | `gcs`, `firestore` or `memory` |
| `BANTO_GCS_BUCKET` | when `gcs` | — | Bucket holding one state object per pool |
| `BANTO_GCS_PREFIX` | no | `banto/` | Object name prefix |
| `BANTO_FIRESTORE_PROJECT` | when `firestore` | `GOOGLE_CLOUD_PROJECT`, else the first pool's project | Project holding the database |
| `BANTO_FIRESTORE_DATABASE` | no | `(default)` | Firestore database id |
| `BANTO_FIRESTORE_COLLECTION` | no | `banto-pools` | Collection holding one document per pool |
| `BANTO_RECONCILE_AUDIENCE` | yes | — | `aud` the scheduler's ID token must carry |
| `BANTO_RECONCILE_ALLOWED_EMAILS` | yes | — | Service accounts allowed to reconcile; must be non-empty |
| `BANTO_MIN_PASS_INTERVAL_SECONDS` | no | `10` | Floor between passes for one pool; bounds the GitHub API spend |
| `PORT` | no | `8080` | HTTP port |
| `LOG_LEVEL` | no | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR` |

Each entry of `BANTO_POOLS`:

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `project` | yes | — | Project **id** of the worker pool (not a project number) |
| `location` | yes | — | Region, e.g. `asia-northeast1` |
| `workerPool` | yes | — | Worker pool short name (not a path or full resource name) |
| `labels` | yes | — | Label selector; all must be present on a job |
| `max` | yes | — | Ceiling on instances |
| `min` | no | `0` | Floor on instances, busy or idle |
| `warmSpare` | no | `0` | Idle instances kept *on top of* current demand |
| `name` | no | `workerPool` | Logical name; also the storage key, so letters, digits, `.`, `-`, `_` only |
| `cooldownSeconds` | no | `300` | Required quiet-period grace before every scale-down (0 disables the grace) |
| `scaleDown` | no | `"disabled"` | Prevents downward requests while allowing scale-up; explicitly select `"idle"` to accept observation-based mitigation and its interruption risk |
| `runnerRepo` | no | — | `owner/repo` this pool's runners register to; unset means "cross-check against `GITHUB_ORG`" |

**A pool's address must mean exactly what it says.** The three components are
interpolated into a Cloud Run resource path *and* compared between pools to
catch two pools aiming at one worker pool, so each is validated strictly:
lowercase, and nothing structural — a `workerPool` of `other/../runner` resolves
to the same resource as `runner` while comparing as a different target, and is
rejected rather than accepted as either.

Surrounding whitespace is trimmed rather than rejected, like every other string
in the configuration, so `" runner "` and `"runner"` are one address and are
caught as the same target.

A project **number** is refused even though the API accepts it, because it
addresses the same project as the id and banto cannot tell that
`123456789012` and `my-project` are the same without asking Google. Refusing
the form it cannot compare is better than comparing it wrongly.

**`min` versus `warmSpare`.** `min` is a floor on the pool: with `min: 1` and one
job running you have one instance and it is busy, so the next job waits for a
cold start. `warmSpare` is headroom on top of demand: with `warmSpare: 1` and one
job running you have two instances, one of them ready for the next job. Use `min`
to guarantee capacity exists at all, `warmSpare` to keep a runner waiting. A
warm spare is an instance billed continuously for doing nothing, which is the
point of it and also its cost.

**`runnerRepo`.** Set this to the `owner/repo` your runner image registers
to, when that is a repository rather than the org — check the registration
step in the image, or GitHub's own **Settings -> Actions -> Runners** page for
the repository versus the org. It needs no `GITHUB_ORG` of its own: a
repo-scoped pool's cross-check works whether or not the deployment has one,
because the two are independent scopes read at independent endpoints. When
both are set, `runnerRepo` wins for that pool only — other pools in the same
`BANTO_POOLS` with no `runnerRepo` still cross-check against `GITHUB_ORG`
exactly as before. Getting this backwards (org-scoped runners with a
`runnerRepo` set, or vice versa) reads as the cross-check finding nothing: see
[the runner cross-check](#the-runner-cross-check).

Worked example, three pools on one installation: `runner-default` for small,
frequent jobs such as Terraform plans; `runner-build` for container image
builds, which need more memory and run less often; and `runner-mobile`, whose
image registers to a single repository rather than the org.

```json
[
  {
    "name": "default",
    "project": "my-runners-prd",
    "location": "asia-northeast1",
    "workerPool": "gh-runner-default",
    "labels": ["self-hosted", "runner-default"],
    "min": 1,
    "max": 5,
    "warmSpare": 1,
    "cooldownSeconds": 300
  },
  {
    "name": "build",
    "project": "my-runners-prd",
    "location": "asia-northeast1",
    "workerPool": "gh-runner-build",
    "labels": ["self-hosted", "runner-build"],
    "min": 0,
    "max": 3,
    "cooldownSeconds": 600
  },
  {
    "name": "mobile",
    "project": "my-runners-prd",
    "location": "asia-northeast1",
    "workerPool": "gh-runner-mobile",
    "labels": ["self-hosted", "runner-mobile"],
    "min": 0,
    "max": 3,
    "cooldownSeconds": 600,
    "runnerRepo": "my-org/mobile-app"
  }
]
```

## IAM

banto authenticates with Application Default Credentials, so on Cloud Run it is
the attached service account. It needs:

| Role / permissions | On | Why |
| --- | --- | --- |
| `run.workerpools.get`, `run.workerpools.update` | each target worker pool (or its project) | read and set `manualInstanceCount` |
| `roles/storage.objectUser` | the state bucket | read, write and replace the per-pool state objects |
| `roles/datastore.user` | the Firestore project | only if `BANTO_STORE=firestore` |
| `roles/secretmanager.secretAccessor` | the webhook secret **and** the App private key | both are mounted from Secret Manager |

The bucket role is the one that is easy to get wrong: replacing an object
requires `storage.objects.create` **and** `storage.objects.delete`, so
`roles/storage.objectCreator` is not enough — the first write of each pool
succeeds and every later one fails.
[`roles/storage.objectUser`](https://cloud.google.com/storage/docs/access-control/iam-roles)
is the smallest predefined role that covers create, get and delete;
`roles/storage.objectAdmin` also works and grants more.

The two `run.*` permissions are what banto actually uses; `roles/run.developer`
is the convenient predefined role that contains them, and grants a good deal
more. A custom role is in the Terraform below.

One more grant may be needed, and this README does not resolve it for you.
Google's manual-scaling guide lists Service Account User on the worker pool's
own service account among the roles for changing instance counts. banto does
not create revisions — the PATCH carries `updateMask=scaling` and never touches
the template — which is a reason to expect `iam.serviceAccounts.actAs` not to
be required, but "no new revision" does not by itself establish an exemption,
and this has not been verified against a live project. Grant
`roles/iam.serviceAccountUser` on the runner's service account if you want to
follow the documented prerequisite, or omit it and add it when an `actAs` error
tells you it was needed.

The App credentials are used by **every** pass, not only by `/reconcile`: a
webhook triggers a pass, and a pass asks GitHub what is queued. A webhook that
matches a pool therefore needs working App credentials just as much as the
scheduled reconcile does.

The App needs **Actions: read** (and **Metadata: read**) to list runs and jobs.
The runner cross-check needs a second grant, and which one depends on the
scope: **Administration: read** on the repository for a pool with `runnerRepo`
set, or **Organization -> Self-hosted runners: read** for one that falls back
to `GITHUB_ORG`. `Actions: read` is not enough for either — it covers runs and
jobs, not runner registrations. A pool without
`runnerRepo` needs the deployment to also have **Organization -> Self-hosted
runners: read**, for the org-wide cross-check. Neither form needs the *write*
runner-administration permission the runner image itself uses to register.

## Pointing a GitHub App at it

1. In the App's settings, set **Webhook URL** to `https://<banto-url>/webhook`
   and **Webhook secret** to the value in `GITHUB_WEBHOOK_SECRET`.
2. Subscribe to the **Workflow job** event. That is the only event banto reads;
   anything else is acknowledged with a 202 and dropped.
3. Under **Permissions**, give the App **Actions: read** so `/reconcile` can list
   runs and jobs. The runner cross-check needs one more, depending on scope:
   **Administration: read** on the repository for pools that set `runnerRepo`,
   and **Organization -> Self-hosted runners: read** for pools that rely on
   `GITHUB_ORG` (the App that mints runner registration tokens already has the
   write version of that one; a
   separate App works too).
4. Install it on the org or the repositories whose jobs should drive scaling, and
   put that installation's id in `GH_APP_INSTALLATION_ID` — events from any other
   installation of the same App are rejected. If the installation covers more
   repositories than you want, narrow it with `GITHUB_REPOS`.
5. GitHub's "Recent Deliveries" page is the fastest way to confirm the signature
   and the 200; `ping` is answered with `{"status":"pong"}`.

## Deploying

[`examples/terraform`](examples/terraform) is a complete, runnable
configuration — the service, its identity, the IAM it needs, the state
bucket, the Secret Manager containers, the Cloud Scheduler job that calls
`/reconcile`, an Artifact Registry proxy for the published image (see below),
and one worker pool for banto to manage. `terraform init -backend=false` and
`terraform validate` pass on it as committed; its own README covers what it
creates, what remains a manual step (a GitHub App's private key cannot come
from Terraform, and neither can the runner image), and what to change first.
What follows here is the shape of that configuration, not a copy of it — see
the example for something you can actually apply.

A service account, scoped to exactly what banto uses:

```hcl
resource "google_project_iam_custom_role" "worker_pool_scaler" {
  role_id     = "workerPoolScaler"
  title       = "Worker pool scaler"
  permissions = ["run.workerpools.get", "run.workerpools.update"]
}
```

— instead of `roles/run.developer`, which also works and is the fallback the
example documents for a Terraform identity that lacks `iam.roles.create`.

A state bucket, with two defaults deliberately turned off:

```hcl
resource "google_storage_bucket" "banto_state" {
  versioning { enabled = false }
  soft_delete_policy { retention_duration_seconds = 0 }
}
```

Versioning off is not enough on its own: a new bucket also has soft delete on
by default, which retains overwritten and deleted objects for seven days.
banto overwrites constantly, so that default would keep thousands of dead
generations that nothing will ever read.

A Cloud Run service with a public webhook, and a specific way of making it
public:

```hcl
resource "google_cloud_run_v2_service_iam_member" "public" {
  role   = "roles/run.invoker"
  member = "allUsers"
}
```

That binding is the ordinary way to do it and it does not work everywhere. If
the project is under an organisation policy for **domain restricted sharing**,
granting a role to `allUsers` is rejected. Google's guidance says these
instructions "won't succeed" there and points at disabling the invoker IAM
check instead — "use this solution when the project is subject to the domain
restricted sharing constraint in an organization policy". In Terraform that is
`invoker_iam_disabled = true` on the service, and the `allUsers` binding goes
away entirely.

Either way the whole service is public, which is the point of the paragraph
above: Cloud Run IAM is a property of the service, not of a path.

The runner pools themselves stay as they are — `scaling { scaling_mode =
"MANUAL" }` — but drop `manual_instance_count` from Terraform's control once
banto owns it:

```hcl
lifecycle {
  ignore_changes = [scaling[0].manual_instance_count]
}
```

Otherwise the next `terraform apply` will put the pool back to whatever the
configuration says and fight banto for it.

## The published image

Every `v*` tag is built and published to the GitHub Container Registry by
[`.github/workflows/publish.yml`](.github/workflows/publish.yml), so deploying
banto does not require building it:

```sh
docker pull ghcr.io/sakajunquality/banto:<release tag>
# Digest: sha256:… — that line, as ghcr.io/sakajunquality/banto@sha256:…, is
# what the example's `var.banto_image_digest` takes (see examples/terraform).
# The tag is how you find the digest, not what you deploy.
```

Releases are listed on the repository's releases page; there is nothing to pull
until the first one is tagged.

Two tags per release and no more: the release tag, and `sha-<commit>` with the
full commit the image was built from, so an image can always be traced back to
the source without guessing. There is no `latest` — the example wants a
digest, and a tag that follows the newest release is a way to deploy something
nobody chose. The workflow prints the digest-pinned reference in its job summary,
which is the shortest path from a release to `var.banto_image_digest`.

Neither of those two is a *moving* tag, in the sense that `latest` is one by
design. That is a statement about what the workflow publishes, not a guarantee
the registry enforces: GHCR tags are mutable, so force-moving a git tag and
re-running would overwrite the image a tag resolves to. If you want the
guarantee rather than the intent, deploy the digest — which is what
`var.banto_image_digest` takes, and why the summary prints it.

## Building the image

banto is containerised with [bunko](https://github.com/sakajunquality/bunko) —
no Dockerfile. The `bunko` block in `package.json` is the whole build
configuration.

To build without publishing — a local OCI layout plus the report the numbers
below come from:

```sh
bunx @sakajunquality/bunko@0.7.0 build . --push=false --oci-layout ./.oci --report ./.oci-report.json
```

`bun run build:report` runs exactly that and then reduces the report to
`docs/build-report.json`. It reads `.oci-report.json` by name, so keep the
`--report` path if you run the two steps separately.

To deploy you need the image in a registry and an immutable reference to it.
Building your own means bypassing the ghcr.io proxy in `examples/terraform`
altogether: point `local.banto_image` at your own registry path instead of
assembling it from `var.banto_image_digest`. Publishing is bunko's default,
so drop `--push=false` and give it a repository prefix — the name comes from
`bunko.imageName` in `package.json`:

```sh
gcloud auth configure-docker asia-northeast1-docker.pkg.dev
bunx @sakajunquality/bunko@0.7.0 build . \
  --repo asia-northeast1-docker.pkg.dev/my-runners-prd/containers \
  --image-refs ./image-refs.txt

# The digest-pinned reference — this is what local.banto_image would be set
# to directly, if you build your own instead of pulling the published one.
cat ./image-refs.txt
```

The dependency closure is empty: the only runtime dependency is Hono, and bunko
bundles it into the single entry module, so everything in the image except one
small application layer is the `oven/bun:1.4.2-distroless` base. That also means
`bunko.deps.strategy: "closure"` does nothing here — with nothing left to
install there is no closure to build. It is kept as a statement of intent for the
day a dependency has to stay external.

[`docs/build-report.json`](docs/build-report.json) is the summary of a real
build — image size, layer split, closure contents, and bunko's own digest of
the sources it built — regenerated with `bun run build:report` so the numbers
in it are checkable rather than claimed. It records no git revision on purpose:
the report is produced from the working tree and then committed alongside it,
so any revision it named would be the commit *before* the one shipping it.
`source.digest` identifies the input without that problem.

## Development

```sh
bun install
bun test          # no test opens a socket: clock, store, Cloud Run and GitHub are all injected
bun run typecheck
bun run dev       # BANTO_STORE=memory is the useful local setting
```

Three kinds of test carry most of the weight, and they are worth knowing about
before changing anything:

- `test/interleaving.test.ts` holds a pass open at a chosen point and runs
  something else in that window. Every case is a reproduction of a bug that a
  green suite of ordinary behavioural tests did not catch.
- `test/invariants.test.ts` runs randomised interleavings against a world model
  and asserts invariants over the history of writes.
  [`docs/property-test.md`](docs/property-test.md) records which historical bugs
  it was verified against by reintroducing them, and — more usefully — the
  classes it still cannot reach.
- `test/listing-fuzz.test.ts` asserts that a listing banto cannot read fully is
  never classified as complete, one malformation at a time.

## Known limitations

- **Instances, not runners.** banto scales instances; each instance registers one
  ephemeral runner and exits after one job. Demand of N means N instances, which
  is right for a one-job-per-instance pool and wrong if you ever run more than
  one runner per container. The runner cross-check will not catch that for you:
  it measures `instances - online runners`, which is zero or negative when a
  container registers several runners, so the misconfiguration is invisible to
  the metric that would otherwise flag it.
- **Every pass costs `O(repos x active runs)` GitHub calls.** No org-level
  queued-jobs endpoint exists, and demand is computed rather than accumulated,
  so this is the price of the design. See
  [what it costs](#what-it-costs-and-the-knobs-that-bound-it) before deploying
  against a large installation.
- **A scale-down is still a bet.** See [the hazard](#the-scale-down-hazard):
  banto shortens the window, Cloud Run still picks the victim, and no runner-side
  trick changes that.
- **A pool's runner scope is one repo or the org, not several repos.** Set
  `runnerRepo` for a repository, leave it unset for `GITHUB_ORG`. A pool whose
  runners are split across more than one repository (or split between a
  repository and the org) has no single scope that sees all of them; the
  cross-check would need to read several endpoints and merge the rows, which
  nothing here does. Give such a pool a `runnerRepo` covering its primary
  registration target and accept that the cross-check undercounts, or, better,
  make its registration consistent.
- **One GitHub App, one installation.** Pools spanning two orgs would need a
  second set of credentials; the config has room for it, the code does not.
- **One instance.** banto is not horizontally scalable, by design (see
  [why](#running-as-a-single-instance)). One process handles a CI organisation's
  delivery rate comfortably, since passes coalesce under load.

  If you ever did need to split the work, three constraints make it correct, and
  all three are easy to miss:

  1. **Disjoint selectors.** Most-specific-selector matching only considers the
     pools *one deployment* knows about, so a job matching pools in two
     deployments is claimed by both. Each deployment must own runner labels no
     other deployment's selector can match.
  2. **Exclusive worker pools.** Two deployments must never scale the same Cloud
     Run worker pool; they would fight, each seeing only its own share of the
     demand.
  3. **Separate state**, a bucket or prefix per deployment, and its own
     scheduler job.

  `GITHUB_REPOS` does narrow each deployment's listing, so splitting by
  repository is workable — but only if the label sets are disjoint too, since
  two deployments watching different repositories can still be offered the same
  job labels.
- **With a positive cooldown, surplus capacity is retained while work remains.**
  This includes a pool above `max` after an external change. Once work drains
  and the cooldown elapses, banto converges to the configured idle count. `max`
  still caps every scale-up. This trades extra capacity cost for fewer unsafe
  reductions between jobs; it does not guarantee graceful termination.
- **Each query reads at most `BANTO_MAX_PAGES_PER_QUERY` pages (default 5).**
  That is 500 runners in the org, 500 repositories in the installation, or 500
  active runs in one status for one repository. Past it the listing is
  permanently partial, and partial evidence never shrinks a pool — so an
  installation over the ceiling stops scaling down entirely and quietly holds
  its instances. It fails safe against killed jobs and expensive against the
  bill. Raise the variable if your installation is larger.
- **A pool with `min: 0` and broken runner registration goes quiet.** With no
  demand the pool correctly sits at zero instances, so there is no shortfall to
  report, and a broken image or key only surfaces when the next job queues.
- **A restart loses the cooldown anchor on the in-memory store.** Use GCS or
  Firestore anywhere it matters.

## License

MIT © Jun Sakata
