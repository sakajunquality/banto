terraform {
  required_version = ">= 1.5"
  required_providers {
    google = { source = "hashicorp/google", version = ">= 6.37, < 9" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "us-central1"
}
variable "banto_image" {
  type        = string
  description = "Build this branch and supply an Artifact Registry image digest. Older releases do not support jobs."
}
variable "runner_image" {
  type        = string
  description = "Artifact Registry digest built from runner/Dockerfile, with the workflow's required tools."
}
variable "github_org" { type = string }
variable "github_repos" { type = list(string) }
variable "github_app_id" { type = string }
variable "github_installation_id" { type = string }
variable "github_app_key_secret" {
  type        = string
  description = "Existing Secret Manager secret ID. Its latest version holds the App private key."
}
variable "webhook_secret" {
  type        = string
  description = "Existing Secret Manager secret ID for webhook HMAC verification."
}
variable "runner_group_id" {
  type    = number
  default = 1
}
variable "max_runners" {
  type    = number
  default = 3
}
variable "task_timeout_seconds" {
  type    = number
  default = 3600
  validation {
    condition     = var.task_timeout_seconds > 120 && var.task_timeout_seconds <= 604800
    error_message = "Task timeout must exceed the 120-second idle deadline and be at most seven days."
  }
}

resource "google_service_account" "controller" { account_id = "banto-jobs-controller" }
resource "google_service_account" "runner" { account_id = "banto-jobs-runner" }
resource "google_service_account" "scheduler" { account_id = "banto-jobs-scheduler" }

resource "google_storage_bucket" "state" {
  name                        = "${var.project_id}-banto-jobs-state"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  versioning { enabled = true }
  # Reservation history aids recovery; retain a bounded set of old versions.
  lifecycle_rule {
    condition { num_newer_versions = 10 }
    action { type = "Delete" }
  }
}

resource "google_storage_bucket_iam_member" "controller_state" {
  bucket = google_storage_bucket.state.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.controller.email}"
}

resource "google_secret_manager_secret_iam_member" "controller_secrets" {
  for_each  = toset([var.github_app_key_secret, var.webhook_secret])
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.controller.email}"
}

# A job definition consumes no continuously running runner capacity. banto
# launches one-task executions and never cancels them due to lower demand.
resource "google_cloud_run_v2_job" "runner" {
  name                = "banto-runner"
  location            = var.region
  deletion_protection = true
  template {
    task_count  = 1
    parallelism = 1
    template {
      service_account = google_service_account.runner.email
      max_retries     = 0
      timeout         = "${var.task_timeout_seconds}s"
      containers {
        name  = "runner"
        image = var.runner_image
        resources { limits = { cpu = "1", memory = "2Gi" } }
      }
    }
  }
}

resource "google_project_iam_custom_role" "launch" {
  role_id     = "bantoRunnerLaunch"
  title       = "Launch and observe runner executions"
  permissions = ["run.jobs.get", "run.jobs.run", "run.jobs.runWithOverrides", "run.executions.get", "run.executions.list"]
}
resource "google_cloud_run_v2_job_iam_member" "launch" {
  name     = google_cloud_run_v2_job.runner.name
  location = var.region
  role     = google_project_iam_custom_role.launch.id
  member   = "serviceAccount:${google_service_account.controller.email}"
}
resource "google_project_iam_custom_role" "operations" {
  role_id     = "bantoOperationReader"
  title       = "Observe Cloud Run operations"
  permissions = ["run.operations.get"]
}
resource "google_project_iam_member" "operations" {
  project = var.project_id
  role    = google_project_iam_custom_role.operations.id
  member  = "serviceAccount:${google_service_account.controller.email}"
}

# No IAM grants, App key, or state-store access for the runner service account.
locals {
  audience = "banto-jobs-reconcile"
  environment = {
    BANTO_POOLS = jsonencode([{
      name          = "jobs-default", backend = "jobs", project = var.project_id, location = var.region,
      job           = google_cloud_run_v2_job.runner.name, labels = ["self-hosted", "banto-jobs"],
      min           = 0, max = var.max_runners, warmSpare = 0,
      runnerGroupId = var.runner_group_id, idleTimeoutSeconds = 120
    }])
    BANTO_GCS_BUCKET               = google_storage_bucket.state.name
    BANTO_RECONCILE_AUDIENCE       = local.audience
    BANTO_RECONCILE_ALLOWED_EMAILS = google_service_account.scheduler.email
    GH_APP_ID                      = var.github_app_id
    GH_APP_INSTALLATION_ID         = var.github_installation_id
    GITHUB_ORG                     = var.github_org
    GITHUB_REPOS                   = join(",", var.github_repos)
  }
  secrets = {
    GH_APP_PRIVATE_KEY    = var.github_app_key_secret
    GITHUB_WEBHOOK_SECRET = var.webhook_secret
  }
}

resource "google_cloud_run_v2_service" "controller" {
  name                = "banto-jobs"
  location            = var.region
  deletion_protection = true
  scaling {
    min_instance_count = 0
    max_instance_count = 1
  }
  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
  template {
    service_account = google_service_account.controller.email
    timeout         = "180s"
    containers {
      image = var.banto_image
      resources {
        limits   = { cpu = "1", memory = "256Mi" }
        cpu_idle = true
      }
      dynamic "env" {
        for_each = local.environment
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      ports { container_port = 8080 }
      startup_probe {
        http_get { path = "/healthz" }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.controller_secrets]
}

resource "google_cloud_run_v2_service_iam_member" "webhook" {
  name     = google_cloud_run_v2_service.controller.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_scheduler_job" "reconcile" {
  name             = "banto-jobs-reconcile"
  region           = var.region
  schedule         = "* * * * *"
  attempt_deadline = "180s"
  http_target {
    uri         = "${google_cloud_run_v2_service.controller.uri}/reconcile"
    http_method = "POST"
    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = local.audience
    }
  }
}

output "webhook_url" { value = "${google_cloud_run_v2_service.controller.uri}/webhook" }
output "runner_job" { value = google_cloud_run_v2_job.runner.name }
