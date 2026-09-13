resource "google_cloud_scheduler_job" "reconcile" {
  project     = var.project_id
  region      = var.region
  name        = "banto-reconcile"
  description = "Re-derive runner demand from the GitHub API and correct each pool"
  schedule    = "*/5 * * * *"
  time_zone   = "Etc/UTC"

  attempt_deadline = "120s"

  retry_config {
    retry_count = 1
  }

  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.banto.uri}/reconcile"

    oidc_token {
      service_account_email = google_service_account.banto_scheduler.email
      audience              = local.reconcile_audience
    }
  }
}
