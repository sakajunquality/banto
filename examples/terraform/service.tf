resource "google_cloud_run_v2_service" "banto" {
  project             = var.project_id
  name                = "banto"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL" # GitHub has to reach /webhook
  deletion_protection = false                 # so `terraform destroy` works while you're trying this out

  # Service level, not template level: template.scaling.max_instance_count is
  # per revision, so two revisions could run an instance each. This caps the
  # total across revisions, and it is required, not a tuning choice — see
  # "Running as a single instance" in the README.
  scaling {
    max_instance_count = 1
  }

  # Keep every request on the newest revision: a traffic split keeps two
  # revisions serving indefinitely, which makes concurrent appliers permanent.
  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  template {
    service_account = google_service_account.banto.email

    containers {
      image = local.banto_image # ghcr.io/sakajunquality/banto, proxied — see registry.tf

      env {
        name  = "BANTO_POOLS"
        value = jsonencode(local.banto_pools)
      }
      env {
        name  = "BANTO_GCS_BUCKET"
        value = google_storage_bucket.banto_state.name
      }
      env {
        # One pool against a two-repository installation: a handful of calls
        # a pass, at most 360 passes an hour. Work this out for your own
        # installation before deploying — see "What it costs" in the README.
        name  = "BANTO_MIN_PASS_INTERVAL_SECONDS"
        value = "10"
      }
      env {
        name  = "GITHUB_REPOS"
        value = join(",", var.github_repos)
      }
      env {
        name  = "GITHUB_ORG"
        value = var.github_org
      }
      env {
        name  = "BANTO_RECONCILE_AUDIENCE"
        value = local.reconcile_audience
      }
      env {
        name  = "BANTO_RECONCILE_ALLOWED_EMAILS"
        value = google_service_account.banto_scheduler.email
      }
      env {
        name  = "GH_APP_ID"
        value = var.gh_app_id
      }
      env {
        name  = "GH_APP_INSTALLATION_ID"
        value = var.gh_app_installation_id
      }
      env {
        name = "GITHUB_WEBHOOK_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.banto_webhook_secret.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "GH_APP_PRIVATE_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.gh_app_key.secret_id
            version = "latest"
          }
        }
      }

      ports {
        container_port = 8080
      }

      startup_probe {
        http_get { path = "/healthz" }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.banto_webhook_secret,
    google_secret_manager_secret_iam_member.gh_app_key,
    google_secret_manager_secret_version.banto_webhook_secret,
    google_secret_manager_secret_version.gh_app_key,
  ]
}
