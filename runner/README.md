# One-job serverless runner

This image is for banto's opt-in Cloud Run Jobs backend, not the worker-pool
backend. It combines the upstream GitHub Actions runner with a small Bun
supervisor. The Dockerfile pins both base images by digest; update these pins
deliberately as runner/runtime releases change.

Build from the repository root:

```sh
docker build --platform linux/amd64 -f runner/Dockerfile -t banto-runner:local .
```

Publish your build to Artifact Registry and supply its digest as `runner_image`
in [the Terraform example](../examples/terraform-jobs/README.md). The deployment
must have one container named `runner`, one task, zero task retries, and a task
timeout greater than the idle deadline. The controller checks these constraints
before each launch.

## Runtime contract

The controller supplies these execution overrides:

| Variable | Purpose |
| --- | --- |
| `BANTO_LAUNCH_ID` | Correlates the execution with its durable reservation |
| `BANTO_JIT_CONFIG` | One-job credential from GitHub's JIT configuration API |
| `BANTO_RUNNER_IDLE_SECONDS` | Unused-runner deadline; default 120, range 1–3600 |

The supervisor runs `/home/runner/run.sh --jitconfig ...` as the upstream
non-root `runner` user. The JIT configuration is not forwarded in the listener's
environment, but is necessarily present in its arguments and the Cloud Run
execution configuration. Restrict execution readers. Do not bake credentials
into an image or give the runner the controller service account.

`ACTIONS_RUNNER_HOOK_JOB_STARTED` writes a marker in a private temporary directory.
If that marker exists at the idle deadline, the supervisor leaves the listener
running until it exits. Otherwise it sends SIGINT and treats the unused runner's
exit as successful. External SIGTERM/SIGINT also forwards SIGINT; the platform's
termination deadline still applies. The controller cleans up registration only
after Cloud Run confirms execution completion.

The marker is not an atomic admission barrier: assignment can arrive before the
hook runs. Idle termination can still race that assignment. The Cloud Run task
timeout also covers startup and waiting, not just workflow steps. Size it above
the workflow's expected total lifetime. See [the design](../docs/runner-retirement.md)
for the safety boundary and recovery behavior.

## Workload compatibility

This is not a GitHub-hosted runner's tool image. Add the tools your workflows
need in a derived image, retaining the entrypoint and non-root user. Cloud Run
does not provide privileged Docker-in-Docker; Docker-based actions, job/service
containers, and workloads needing a Docker socket are not supported by this
example. Start with a trusted, simple shell workflow and a distinct label.

Do not run untrusted pull-request code with privileged credentials. The sample
runner service account has no IAM grants; introduce workload-specific identity
separately if needed, with explicit repository and workflow restrictions.

Local tests exercise idle exit, completion after the idle deadline, startup
failure, and missing credentials. Offline Docker smoke tests check the same
mechanics on Linux, without registering a real runner. Live integration remains
part of the canary checklist in the deployment guide.
