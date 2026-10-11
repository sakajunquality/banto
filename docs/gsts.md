# GitHub authentication through gsts

Status: experimental integration with unreleased gsts. There is no public
gsts release or supported installation package assumed by this guide. You
must separately deploy a reviewed, compatible gsts endpoint; banto does not
bundle or deploy the service. The exchange contract may change before release.

The controller can exchange its Google service account identity for a scoped
GitHub installation token through gsts. It does not need an App private key.
The existing PEM mode remains available; configuring both modes is rejected.

Set all four variables:

```
GSTS_URL=https://YOUR-GSTS-SERVICE.run.app
GSTS_AUDIENCE=https://gsts.example.com
GSTS_SCOPE=example-org/infra
GSTS_IDENTITY=banto-prd
```

Keep `GH_APP_INSTALLATION_ID` for webhook installation filtering. Omit
`GH_APP_ID` and `GH_APP_PRIVATE_KEY`. The controller uses the Cloud Run metadata
server; gsts authentication is intentionally not derived from local ADC files.
The metadata ID token uses `GSTS_AUDIENCE`. When gsts has Cloud Run IAM enabled,
configure that value as a custom audience and grant invoker to the controller.
banto sends the token in both `Authorization` and `X-Serverless-Authorization`
so gsts still receives an intact token for its own signature verification.
See [Cloud Run authentication](https://docs.cloud.google.com/run/docs/authenticating/service-to-service).

Put the policy on the scope's default branch at
`.github/gsts/banto-prd.sts.toml`:

```toml
[google]
service_account = "banto-controller@example-prd.iam.gserviceaccount.com"

[permissions]
actions = "read"
administration = "write"
```

This example permits repo-scoped JIT registration and retirement. An org
runner needs an org-scope policy (in the organization's `.github` repo) and
`organization_self_hosted_runners = "write"` instead. A worker-pool-only
observer can use read permissions. The App itself must have `contents:read`
for policy loading, and all permissions the policy authorizes.

Tokens are cached only until shortly before their returned expiry. Concurrent
refreshes share a request. Denial, malformed/expired credentials, and timeouts
fail the reconcile; there is no fallback to a PEM or a broader token.
Redirects are forbidden on metadata and token exchange. Response bodies and
credentials are not included in errors.

With the Jobs backend, only the controller receives the installation token.
The runner receives a one-job JIT configuration and must not be authorized by
a gsts controller policy. Separating Google identities isolates Cloud Run
permissions, but GitHub installation permissions are not scoped by runner
label or group. Controllers sharing repo administration authority are still
mutually trusted for runner registration. A stronger boundary requires a
trusted JIT registrar that enforces registration scope and labels per caller.

Live acceptance must verify the actual metadata claims, KMS-imported App key,
policy on the default branch, token scope, JIT launch, and retirement. Unit
tests do not establish that these external resources have been configured.
