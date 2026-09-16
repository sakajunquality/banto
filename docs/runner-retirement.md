# Serverless runner admission and retirement

Implementation and design follow-up for [Issue #7](https://github.com/sakajunquality/banto/issues/7).
The interim worker-pool guard was merged in [PR #8](https://github.com/sakajunquality/banto/pull/8).
Sources checked September 16, 2026.

## Product objective

Start small, pay primarily for active work, isolate credentials, and scale
runner compute from zero to many and back to zero. Kubernetes/ARC migration
is not the objective: that introduces the infrastructure this project exists
to avoid. ARC is a useful lifecycle reference, not a deployment dependency.

The new opt-in `jobs` backend uses one Cloud Run Job execution and one JIT runner
per launch. Lower demand stops new launches; running executions finish on their
own. The old `worker-pool` backend remains available with its documented limits.

## Lifecycle

```text
webhook / scheduled reconcile
    -> fresh GitHub demand
    -> durable launch reservation, bounded by max
    -> one-job JIT configuration
    -> Cloud Run execution (one task, no platform retries)
         -> first job starts: disable idle deadline
         -> job finishes: listener exits -> execution terminal -> cleanup
         -> no job starts: idle deadline -> listener exits -> cleanup
    -> no outstanding demand or executions: zero runner compute
```

The controller remains a request-driven Cloud Run service with minimum zero
and maximum one instance. Cloud Scheduler supplies recovery triggers; there
is no continuously polling listener, cluster, or always-running runner.

### State and acknowledgements

| State | Evidence | Recovery |
| --- | --- | --- |
| Reserved | Durable launch ID exists before any run POST | Counts toward max even when no execution has been observed |
| Starting / active | Execution is positively identified by launch ID | Poll its individual resource; never terminate it because demand falls |
| Retiring | Ephemeral listener finishes, or its idle deadline fires | Wait for platform terminal status; a missing heartbeat is not completion |
| Retired | Platform execution has a completion timestamp | Remove its stale GitHub registration if needed, then release its reservation |
| Rejected | Positive evidence that no run was submitted/accepted | Persist rejection, retry registration cleanup, then release with backoff |
| Unknown | Run response or subsequent state write was lost | Search execution pages for that launch ID; retain the slot and never replay the POST |

These are lifecycle descriptions, not new runner-to-controller HTTP endpoints.
The GitHub job-start hook only informs the local supervisor. Completion
acknowledgements come from the Cloud Run execution API, independently of webhook
delivery and runner registration visibility. A stale GitHub registration never
counts as usable execution capacity.

Demand stays in GitHub. No webhook is a promise to launch a runner specifically
bound to its job ID; another eligible runner may take that job. Pending execution
reservations and active executions are counted once against queued plus running
demand. Excess executions are allowed to finish rather than being cancelled.

The configured job must be dedicated to banto. Manual execution, replaying run
overrides, a second independent autoscaler, or deleting the state object can
break the reservation-based cost bound. Keep the single-controller deployment
contract, preserve state across controller restarts, and use a new logical pool
name when changing the underlying Cloud Run job.

### Ambiguous launches and failures

The documented [jobs.run API](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/run)
has no request idempotency key. A transport error or 5xx does not prove that a
paid execution was never created. A reservation is therefore persisted before
the call. Its JIT secret is not stored in the state document.

Successful responses supply operation/execution names. Lost responses are
recovered by finding the unique launch ID in execution overrides. Finding
nothing, a truncated listing, elapsed time, or a controller restart never
releases an unknown reservation. Discovery is limited by
`BANTO_MAX_PAGES_PER_QUERY`; normal monitoring uses individual execution GETs
and does not scan an ever-growing history.

If a request truly never reached Cloud Run, its reservation can remain unknown
indefinitely. The controller logs a warning after two minutes. This deliberately
trades some availability for protection against duplicate launches and runaway
cost. Recovery requires an operator to establish the request outcome using
execution history and audit logs, then edit only the affected reservation using
the store's version precondition. Do not automatically delete the entire state
or expire unknown reservations. A future implementation can investigate Cloud
Run execution tokens to reduce this uncertainty.

Definite pre-submission failures and rejected run requests release the slot.
Failed terminal tasks and failed submissions back off from 30 seconds to
15 minutes per pool. Each pass starts at most ten runners. `max` bounds outstanding
reservations, including pending starts; it is not a monthly spending limit.
Cleanup failures retain reservations for retry rather than losing ownership.
If JIT registration succeeds but its HTTP response is lost, there is no runner
ID to clean up. No Cloud Run launch follows that error; an unused GitHub
registration may remain and require separate cleanup. It never counts as
execution capacity.

## Security boundary

The controller owns the App private key and creates [JIT runner
configurations](https://docs.github.com/en/rest/actions/self-hosted-runners).
Each task receives only its own one-job configuration. It receives no App
private key, controller identity, state-store permissions, or permission to start
other executions.

JIT creation and registration cleanup need organization Self-hosted runners
write permission, or repository Administration write permission for
`runnerRepo`. Retain Actions read permission for demand observations and restrict
the installation to the intended repositories. Select the actual runner group
ID when it differs from the default group.

The Terraform example gives the controller a job-scoped custom role for reads
and launches, plus project-scoped operation reads. It grants neither execution
cancellation nor job-template updates. The runner service account has no IAM
grants. Workflow-specific cloud permissions, if needed, should be introduced
separately and scoped to that workload. Webhook HMAC/installation checks and
the scheduler's OIDC allowlist remain in force.

JIT configuration is an execution override and is visible to principals that can
read that execution's configuration. It is also passed to the runner process.
It is a narrowly scoped credential, not a secret vault; restrict configuration
readers. API errors and durable state never include the JIT configuration.
The runner image must not bake in administrative credentials.

## What this improves, and what it does not guarantee

There is no aggregate downward PATCH on the jobs path and no execution-cancel
method in its client interface. Finishing a short job therefore cannot choose
an unrelated long-running runner as the victim of capacity reclamation. New
executions can launch while older ones finish.

There is still a race at the idle deadline. GitHub can assign the first job
before the runner's job-start hook runs. If the deadline wins, the listener is
interrupted and that job may be requeued or fail. The hook is not an atomic
admission barrier. Increasing `idleTimeoutSeconds` reduces exposure at a cost;
it does not eliminate it. The supervisor does not apply its idle deadline after
the start marker is observed.

Cloud Run's task timeout applies to the whole task, including startup/waiting,
and can interrupt a busy runner. Infrastructure failures and user cancellations
also remain possible. Choose the task timeout above expected waiting plus job
runtime, within [platform limits](https://docs.cloud.google.com/run/docs/configuring/task-timeout).
The sample uses one hour and zero task retries. Re-running a Cloud Run task is
not equivalent to re-running a failed GitHub job.

This is not ARC parity: there is no scale-set listener, atomic acquisition
protocol, warm pool, privileged Docker-in-Docker support, or guarantee that
arbitrary workflows run unchanged. The first implementation requires
`min: 0` and `warmSpare: 0`. Cloud Run's container capabilities and available
tools must fit the workload.

## Cost model

Runner compute returns to zero after executions exit, including unused runners
that reach the idle deadline. The controller can scale to zero between requests.
Scheduler, state storage/requests, images, logs, and network traffic still cost
money; scale-to-zero is not a zero total bill.

Cloud Run Jobs bills an instance's lifetime with a one-minute minimum.
A rough workload estimate is the sum of
`max(60 seconds, startup + waiting + job + shutdown)` for every execution,
multiplied by configured CPU/memory rates, plus control-plane and network costs.
Use the [current pricing table](https://cloud.google.com/run/pricing) for the
actual region and shared free-tier usage. Short jobs can spend a substantial
fraction on cold starts and minimum billing; sustained workloads may not be
cheaper than other execution platforms.

The example starts with `max: 3`, no warm capacity, a 120-second idle deadline,
and one-minute reconciliation. Tune reconciliation frequency against API
budget, startup latency, and cost. Bursts larger than ten launches need further
passes. Failed images are throttled, but budget alerts remain useful.

## Start small and validate

Use [the standalone Terraform example](../examples/terraform-jobs/README.md)
and [runner image](../runner/README.md). Build the controller from this branch;
older published images do not implement this backend.

1. Keep the existing pool and its labels available while testing a distinct
   `banto-jobs` label. Grant JIT permission only to the test scope.
2. Run a single short job; verify one launch, one registration, terminal status,
   registration cleanup, and zero outstanding reservations.
3. Run several jobs of different lengths. Verify completed executions retire
   while long jobs keep the same execution identity. Queue new work during this.
4. Exercise an unused runner, a controller restart, a temporarily unavailable
   state store/API, a broken runner image, and a lost response. Observe the
   documented backoff and unknown-reservation behavior.
5. Move workloads gradually only after tools, permissions, execution duration,
   startup latency, and measured cost fit the requirements. Do not retire the
   old aggregate pool merely because one REST listing reports no busy runners.

Synthetic tests cover these controller paths, transport parsing, both durable
codecs, scoped JIT registration, and supervisor idle/busy behavior. Docker build
and offline container smoke checks validate image mechanics; Terraform validation
checks configuration structure. These are not live GitHub/Cloud Run integration
results. No production deployment is changed by this PR.

## Why the worker-pool protocol is still limited

PR #8's cooldown recovery fix remains useful for the explicitly selected
`scaleDown: "idle"` policy. Its default `disabled` policy is containment, not the
long-term cost solution.

A safe aggregate reduction would require every possible termination victim to
stop admission, settle in-flight assignments, finish accepted work, and
acknowledge retirement, including replacements and new revisions. Admission
must remain closed through completion of the platform operation. Neither
runner DELETE nor label removal documents that complete barrier, and the
[worker-pool API](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.workerPools)
does not accept the identity of a retired victim. Retiring one idle runner or
increasing `min` therefore does not protect another busy instance.

The serverless jobs backend avoids that aggregate-victim problem while exposing
its smaller, explicit limitations. It is a practical step toward the requested
zero-to-many-to-zero behavior, not a claim of perfect graceful completion.
