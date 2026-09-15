# Runner admission and retirement

Design investigation for [Issue #7](https://github.com/sakajunquality/banto/issues/7),
reviewed against [PR #8](https://github.com/sakajunquality/banto/pull/8)
at `6a881a94b61672bb1ad5e6aa45a2b77febd8ce3c`. Sources checked September 15, 2026.

## Decision and scope

The current worker-pool controller cannot guarantee safe automatic retirement.
It observes GitHub and changes a Cloud Run aggregate count; it controls neither
job admission nor the identity of the instance that Cloud Run terminates.
Cooldown and confirmation reduce exposure but cannot supply either capability.

The supported containment is `scaleDown: "disabled"`: banto requests no downward
updates, even above `max`, while still adding capacity. This prevents new
controller-initiated scale-down from selecting a busy instance. It does not
reclaim capacity, undo pending updates, or guarantee survival of infrastructure
failures, deployments, manual changes, timeouts, or job cancellation. Omitted
policies default to `disabled`, including existing configurations on upgrade.
Selecting `idle` explicitly retains the documented race. This changes automatic
reclamation and billing behavior; it does not change scale-up limits.

For automatic reclamation with a stronger lifecycle guarantee, use ARC runner
scale sets on an isolated Kubernetes cluster as the recommended migration target.
Job protection takes priority over retaining worker pools. A pool-wide protocol remains conditional on capabilities
listed below; this document does not declare it implemented or platform-verified.

## What the APIs actually establish

| Mechanism | Established behavior | Missing guarantee |
| --- | --- | --- |
| GitHub job and runner listings | Observations of queue and runner state | No atomic snapshot with future assignment or Cloud Run termination |
| `--ephemeral` / JIT runner | At most one job per runner registration | An unused runner can still receive its first job |
| Runner registration deletion | Removes the registration | No documented drain acknowledgement settling an assignment already in flight |
| Removing custom labels | Changes routing labels | No documented cancellation of an assignment already sent; default labels remain |
| Worker-pool count PATCH | Changes total desired capacity | No choice of retired victim, admission barrier, or busy-instance protection |
| Worker-pool etag | Detects resource update conflicts | Does not fence GitHub assignment or prove an earlier operation finished |
| SIGTERM handling | Cloud Run allows a short shutdown interval before SIGKILL | Cannot wait for an arbitrary CI job to finish |

These distinctions follow the official [GitHub runner lifecycle and routing
reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners),
[runner REST API](https://docs.github.com/en/rest/actions/self-hosted-runners),
[worker-pool API](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.workerPools),
and [worker-pool runtime contract](https://docs.cloud.google.com/run/docs/container-contract#worker-pools).
GitHub documents registration deletion as forced removal, not graceful draining.
Inferring atomic retirement from a successful DELETE or a later empty list would
therefore exceed the documented contract.

Cloud Run also documents a separate [Instances
resource](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.instances)
with its own lifecycle methods. That is not a documented target selector for
worker-pool scaling. An individual-instance backend would be a separate design
and still needs to settle runner admission before stopping anything.

## Counterexample to repeated observation

1. Both GitHub observations report two idle runners and no work; grace has elapsed.
2. GitHub assigns a job to runner A after confirmation.
3. banto requests a count of one.
4. Cloud Run may choose A, despite runner B remaining idle.

Increasing grace, adding a third read, or setting `min: 1` does not invalidate
this sequence. Neither does retiring B first: the count update still cannot
select B. The same race can occur after PATCH acceptance while Cloud Run applies
the asynchronous update. `test/retirement.test.ts` reproduces the controller's
downward request with a newly busy runner; it does not simulate Google's victim
selection or claim that a fake demonstrates live platform behavior.

## Review of PR #8

The mandatory grace and second observation are useful interim mitigation. They
must not close the coordinated-retirement issue as a completed implementation.

**P2: failed confirmation can preserve an expired cooldown anchor.**
In the reviewed `src/controller.ts`, `recordObservation` reads Cloud Run and
storage before persisting the new anchor. If confirmation observes incomplete
evidence and either read or the state write fails, the old valid anchor remains.
The next complete idle observation can immediately shrink the pool. A failed
scale operation similarly leaves no recovery grace. Restarting the controller
also forgets any busy observation that never reached storage.

The local fix marks failed pools for a cooldown reset, clears that mark only
after successful persistence, and seeds every newly started controller the same
way. It adds no demand cache or schema. Synthetic regressions failed on the PR
head for pool reads, state reads, state writes, scale writes, and restart; they
now require a full grace period after recovery. Scale-up remains available.

**Documentation:** the log example still used `idleEvidence: "runners"` after
the shortcut was removed. The property-test document also described the previous
surplus-capacity policy. Both are corrected. The older recommendation that a
capacity floor protects a busy runner is corrected separately: it protects only
the count, not an instance.

## Requirements for a pool-wide barrier

The following is a protocol specification to evaluate, not an available mode.
All candidate victims must be retired before lowering an aggregate count. A
quorum, an idle subset, or a count of acknowledgements is insufficient.

| State | Admission and work | Transition evidence |
| --- | --- | --- |
| `active` | May register and accept work in the current generation | Durable retirement request starts a new generation |
| `draining` | No new admission; already accepted work may finish | Trusted supervisor proves admission is closed, in-flight assignments are settled, and the job process has exited |
| `retired` | No runner listener and no automatic re-registration | Terminal acknowledgement bound to pool, instance identity, boot identity, and retirement generation |
| `unknown` | Admission remains closed; capacity is not usable | Recovery obtains fresh authoritative identity and lifecycle evidence; never infer retirement from a missing heartbeat |

Required ordering:

1. Persist a pool generation with admission closed. Every existing supervisor,
   replacement, new revision, and new instance must consult the barrier before
   registering or starting a listener. Admission fails closed on control-store
   failure; a running job may continue. An admission lease may not expire into
   permission to kill a job.
2. Each supervisor settles assignments already in flight. `busy: false`, label
   removal, DELETE, a job-start hook, or a sleeping listener is not that proof.
   A hook runs after assignment and cannot make killing the assigned job safe.
   If supported listener semantics cannot provide the proof, remain draining.
3. Obtain generation-bound retirement acknowledgements from every possible
   victim, including old revisions and replacements. GitHub registrations and
   `manualInstanceCount` do not establish this set. Lost acknowledgements are
   retried idempotently; a timeout raises an alert and retains capacity.
4. Submit a conditional count update only when the whole victim set is retired.
   Persist the operation identity and requested target. An HTTP success or a
   changed desired count does not establish completed platform reconciliation.
5. Keep admission closed until the operation is terminal and the surviving
   membership is established. A failed or ambiguous operation stays closed until
   resolved. Controller restart resumes the same durable generation. A runner
   restart starts closed with a new boot identity; an old acknowledgement cannot
   authorize its new incarnation.
6. Reopen survivors using a new generation. Duplicated triggers and delayed old
   acknowledgements cannot reopen admission or authorize another reduction.

Queue preservation requires that retirement never cancel GitHub jobs. Arriving
demand may increase requested capacity during retirement, but instances in the
same ambiguous termination domain must remain closed. A second pool or individual
execution domain is needed to provide usable scale-up while the first pool is
closed. Keep demand assigned to the original job labels; select eligible execution
capacity separately. Do not count draining, retired, offline, or unacknowledged
registrations as ready capacity. GitHub's queue retention is finite, so an
indefinitely stuck drain must alert and provide another execution path.

The current repository supplies no runner supervisor, authoritative instance
membership, admission acknowledgement, or operation-completion coordinator.
Until those capabilities are established, this protocol cannot authorize a safe
downward worker-pool PATCH. A mock acknowledging invented capabilities would not
resolve that limitation.

## Alternative execution architecture

Use one ephemeral runner per independently managed execution, with capacity
reclamation driven by runner completion. GitHub recommends
[Actions Runner Controller](https://docs.github.com/en/actions/concepts/runners/actions-runner-controller)
for Kubernetes autoscaling; adopting it avoids writing a new runner lifecycle
controller. The [ARC architecture](https://github.com/actions/actions-runner-controller/blob/master/docs/gha-runner-scale-set-controller/README.md)
describes JIT registration and runner cleanup after completion. Infrastructure
evictions and failures still require separate treatment; ARC is not a blanket
job-completion guarantee.

If remaining on Cloud Run is preferred, a candidate is one task per
[Cloud Run Job execution](https://docs.cloud.google.com/run/docs/create-jobs).
This is a proposed backend, not code shipped by banto:

- Provision a unique ephemeral/JIT registration for each execution. The runner
  starts once, processes at most one job, and exits. Never wrap it in a loop that
  silently registers another runner inside the same lifecycle.
- A falling demand estimate stops new launches; it does not cancel running or
  unassigned executions. Already accepted work finishes naturally. This gives
  the narrow guarantee that autoscaling never terminates a running execution
  because demand decreased. It trades idle execution cost for that guarantee.
- Persist launch intents and execution/runner identities before counting pending
  capacity. Reconcile ambiguous launches before retrying them. Duplicate webhooks
  are triggers, not instructions to launch duplicate tasks; queued jobs are not
  bound to the runner that their webhook happened to create.
- Count confirmed, still-eligible runner capacity separately from pending starts
  and terminal registrations. Never count the same busy runner both as idle
  supply and as an execution serving running demand.
- Use platform-observed terminal execution status to recover from lost completion
  messages. A missing message or heartbeat never authorizes cancellation. New
  executions can start while old ones finish without sharing a termination target.
- Configure task retries deliberately (initially zero); restarting a task is not
  the same as retrying its GitHub job. Set a task timeout covering startup, queue
  wait, and execution, within the [documented task-timeout
  limits](https://docs.cloud.google.com/run/docs/configuring/task-timeout).
  Timeouts and infrastructure termination remain possible failure modes.

This Cloud Run Jobs alternative changes the scaling client, durable state,
runner image contract, and Terraform. It is a fallback if operating Kubernetes
is unacceptable, not the selected migration target. No new execution backend
or infrastructure migration is performed by this review.

### ARC migration plan

1. Enable `scaleDown: "disabled"` for existing banto pools. Resolve any previously
   accepted downward operation before claiming containment. Keep banto running
   for queued work on the original labels during migration.
2. Provision isolated Kubernetes runner capacity, using dedicated infrastructure
   rather than sharing application production nodes. Start the canary without
   Spot/preemptible capacity or automatic disruptive node maintenance. ARC owns
   runner lifecycles; a second autoscaler must not delete runner pods merely
   because their CPU is low.
3. Install pinned ARC controller and runner-scale-set Helm chart versions with
   separate controller/runner namespaces. Supply the GitHub App through an
   existing Kubernetes Secret reference. Validate permissions for the selected
   repository or organization scope. Set a new, distinct `runnerScaleSetName`
   such as `banto-arc-canary`, `minRunners: 0`, and an initial `maxRunners: 3`.
   Use GitHub's [deployment guide](https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/deploy-runner-scale-sets)
   and verify the runner image, tools, container-action requirements, and network
   access against actual workflows before moving them.
4. Route a canary workflow to the new scale-set name. Do not assume banto's
   multi-label, most-specific-selector routing is interchangeable with ARC's
   scale-set routing. Keep the name outside every existing banto selector.
5. Validate a long-running job alongside short jobs that complete, then submit
   fresh demand as other runners retire. Verify that the long-running job's pod
   identity survives capacity reclamation, fresh work starts, and completed
   runners disappear. Repeat with a controller restart, a listener interruption,
   and credential/API failure. Test voluntary node maintenance separately; a
   runner-aware autoscaler does not make infrastructure evictions safe.
6. Move workflows in batches while retaining capacity for jobs already queued
   with old labels. Rollback changes future workflow routing to the old labels;
   it does not delete ARC pods currently executing jobs. For maintenance, ARC's
   documented zero-minimum/zero-maximum setting stops new pod creation, but
   existing jobs and in-flight assignments must still be accounted for.
7. Retire the old worker pool only after its admission has been stopped and
   settled, and all old job processes have exited, with re-registration disabled
   in the runner launcher. An empty REST listing alone is insufficient. If the
   existing runner image cannot establish that state, retain the old capacity
   until an operator can verify quiescence; do not introduce a final unsafe
   aggregate PATCH just to finish the migration. Remove the old banto selectors
   and infrastructure only after old-label demand has drained.

Rollout completion requires recorded canary results, a tested rollback route,
and verified old-pool quiescence. Cluster identity, runner-image requirements,
App scope, and maintenance policy are deployment inputs absent from this
repository; the review does not fabricate them or change a live deployment.

## Least-privilege coordination

Current mitigation and the disabled policy need no new GitHub permissions.
For a future protocol, keep the GitHub App private key and registration authority
in the controller or a separate credential broker. Give a runner only its own
short-lived registration material, never authority to remove other runners or
scale pools. The REST API requires org Self-hosted runners write permission or
repository Administration write permission for registration management; scope
the App installation and broker accordingly.

A supervisor's acknowledgement must use authenticated workload identity plus a
controller-issued capability bound to its execution, boot identity, and generation.
An OIDC audience or an instance ID supplied in a request is not authorization.
Use a separate coordination endpoint and allowlist; the current scheduler-only
`/reconcile` authorization does not authenticate retirement acknowledgements.
Reject replay and cross-pool acknowledgements. A shared service account alone
cannot distinguish sibling instances; do not claim otherwise.

Job code must not possess the capability that attests supervisor state. A sidecar
sharing credentials or a writable control volume with arbitrary workflow code
does not establish this boundary. Bind scaling rights to the controller and
only the managed resources; runners need no pool-update or execution-cancel role.

## Validation and remaining work

Implemented synthetic checks cover confirmation races, busy and incomplete
observations, failed reads/writes and recovery, restart, duplicates, immediate
scale-up, and the no-downward-request invariant in disabled mode. Existing
pagination, authentication, state, and interleaving tests remain applicable.

A future coordinated backend must additionally test assignment crossing drain,
delayed observations, lost/duplicated acknowledgements, wrong generations and boot
identities, controller and supervisor crashes, newly born instances behind a
closed barrier, failed and ambiguous operations, and new demand during retirement.
Those tests must exercise the actual lifecycle adapter and be followed by live
platform validation. No such backend or acknowledgement channel exists yet.

Issue #7's design outcome is therefore explicit: safe automatic retirement is
not established for the present aggregate backend; use disabled scale-down for
containment and individual lifecycles for the architectural solution. Neither
PR #8 nor this mitigation should be represented as a graceful-completion promise.
