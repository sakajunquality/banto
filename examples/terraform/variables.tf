# The five things you will change before this is your deployment rather than
# a demo: project_id, region, the github_* variables, the two secrets in
# secrets.tf, and runner_image. Everything else in this example follows from
# those.

variable "project_id" {
  type        = string
  default     = "my-runners-example"
  description = "CHANGE ME. Project id (not number — see the BANTO_POOLS notes in the README) that hosts banto, its state bucket, and the worker pool it manages."
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "CHANGE ME. Region for the Cloud Run service, the worker pool, the Artifact Registry proxy and the state bucket. Keeping all of them in one region is not required, only convenient."
}

variable "github_org" {
  type        = string
  default     = "example-org"
  description = "CHANGE ME. Org whose runner registrations the reconcile cross-checks (GITHUB_ORG). Only meaningful for pools without their own runnerRepo — this example's one pool has none, so it relies on this."
}

variable "github_repos" {
  type        = list(string)
  default     = ["example-org/infra", "example-org/app"]
  description = "CHANGE ME. Repositories the webhook accepts jobs from and the reconcile lists runs for (GITHUB_REPOS). Leave empty to accept the whole installation."
}

variable "gh_app_id" {
  type        = string
  default     = "123456"
  description = "CHANGE ME. GitHub App ID (GH_APP_ID), from the App's settings page."
}

variable "gh_app_installation_id" {
  type        = string
  default     = "987654321"
  description = "CHANGE ME. Installation ID (GH_APP_INSTALLATION_ID) — events from any other installation of the same App are rejected. Found in the installation's settings URL."
}

variable "banto_image_digest" {
  type        = string
  default     = "sha256:f6f3a7dbb22e2af1259d31ec21b128805b697e37600a4e2128d5cb7e9c416aaf"
  description = "Digest of the banto image to deploy — this default is v0.1.2. Check https://github.com/sakajunquality/banto/pkgs/container/banto for the digest behind a newer tag; the tag is how you find the digest, not what you deploy (see \"The published image\" in the README)."
}

variable "runner_image" {
  type        = string
  default     = "us-docker.pkg.dev/my-runners-example/containers/gh-runner:latest"
  description = <<-EOT
    CHANGE ME. Image for the runner pool banto manages. Neither banto nor this
    example builds it: it needs to be a container that registers itself as an
    ephemeral, self-hosted GitHub Actions runner and exits after one job (see
    "Known limitations" in the README — one runner per instance). Point this
    at your own build; a `:latest` tag is a placeholder here, not a
    recommendation — pin it once you have a real image.
  EOT
}

