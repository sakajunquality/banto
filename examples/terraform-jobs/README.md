# Small serverless runner deployment

This standalone example implements banto's opt-in `jobs` backend. It does not
modify or migrate the [worker-pool example](../terraform/). No GKE cluster is
required. Start with a separate `banto-jobs` workflow label and at most three
concurrent runner reservations.

## Before deployment

- Enable Cloud Run, Cloud Scheduler, Secret Manager, IAM, and Cloud Storage APIs
  in the project. Provision Artifact Registry and image-pull access separately.
- Build the controller from this branch using the root README's bunko build
  instructions. Older published banto images do not support this backend.
- Build [the runner image](../../runner/README.md), adding only the workload's
  required tools. Push both images to Artifact Registry and use digest references.
- Create Secret Manager secrets for the GitHub App PEM private key and webhook
  HMAC secret. Pass only their IDs to Terraform, not secret values. Restrict
  access to Terraform state and do not commit a real variables file.
- Install the App on the intended repositories with Actions read and
  organization Self-hosted runners write permissions. The latter is required
  for JIT registration and cleanup. Confirm the actual runner group ID and
  restrict that group's repository access.
- The deploying identity needs resource/IAM provisioning permissions and
  permission to act as the created service accounts. This example does not
  grant deployment privileges to the controller.

Example non-secret input file (`terraform.tfvars`, gitignored):

```hcl
project_id                 = "my-runners-prd"
region                     = "us-central1"
banto_image                = "us-central1-docker.pkg.dev/my-runners-prd/ci/banto@sha256:REPLACE"
runner_image               = "us-central1-docker.pkg.dev/my-runners-prd/ci/runner@sha256:REPLACE"
github_org                 = "example-org"
github_repos               = ["example-org/example-repo"]
github_app_id              = "12345"
github_installation_id     = "67890"
github_app_key_secret      = "github-app-key"
webhook_secret             = "github-webhook-secret"
runner_group_id            = 1
max_runners                = 3
task_timeout_seconds       = 3600
```

Then, from this directory:

```sh
terraform init
terraform validate
terraform plan
# Inspect the resource and IAM changes before applying.
terraform apply
```

Set the GitHub App webhook URL to the `webhook_url` output, enable the
`workflow_job` event, and configure the matching webhook secret. The public
Cloud Run service verifies webhook HMAC and installation/repository scope in
the application. If organization policy prevents an `allUsers` invoker grant,
resolve public GitHub webhook ingress before deployment; do not bypass the
application's authentication checks.

## Defaults and boundaries

- Controller: request-based CPU, minimum zero, service-level maximum one,
  latest revision receives all traffic. No tagged revisions serving requests,
  traffic splits, second controller, or manual runner executions.
- Recovery: Cloud Scheduler calls `/reconcile` once per minute with an OIDC
  token from a dedicated, explicitly allowlisted service account.
- Runners: one task per execution, no retries, 1 vCPU / 2 GiB, no warm capacity,
  120-second unused-runner deadline, one-hour total task timeout. Adjust resources
  and timeout to fit workflow startup, waiting, and runtime.
- State: versioned GCS bucket with bounded old-version retention. Never delete
  active reservations or reuse a logical pool name for a different job.
- Credentials: only the controller can read App/HMAC secrets and state. It can
  launch/read this job and read operations, but cannot cancel executions or
  update the job template. The separate runner identity has no IAM grants.

The Job definition itself is not continuously running compute. Runners reach
zero after completion or unused-runner expiry, and the controller can reach
zero between requests. Jobs have a one-minute billing minimum; scheduler,
storage requests, registry, logs, and network traffic remain billable.
`max_runners` limits outstanding reservations, not total monthly spend.
Configure billing alerts and inspect measured cost before increasing it.

This example is organization-scoped. For repository-scoped JIT registration,
set `runnerRepo` in `BANTO_POOLS`, use repository Administration write permission,
and ensure the pool's labels/demand scope cannot include another repository.

## Canary acceptance

Use a trusted workflow without Docker-based actions or service containers:

```yaml
jobs:
  canary:
    runs-on: [self-hosted, banto-jobs]
    strategy:
      matrix:
        seconds: [10, 40, 180]
    steps:
      - run: sleep "${{ matrix.seconds }}"
```

Verify one execution/registration per reservation, concurrent starts, and each
completed execution disappearing from active state while the long job keeps
running. Queue another job during retirement. After demand drains, check zero
running executions and eventual empty reservation state. Also test an unused
runner, restart, API failure, and broken image at a small concurrency bound.

Do not interpret a missing runner or missing execution in a list as proof that
it stopped. Unknown launches remain reserved, without automatic replay, and may
require audit-log investigation and a conditional state edit. Idle expiry can
race first assignment; platform timeout can interrupt active work. Read the
[full lifecycle and limitations](../../docs/runner-retirement.md) before migrating.

Terraform validation and offline container/controller tests have been run.
This change does not claim a live-cloud canary or deploy production resources.
