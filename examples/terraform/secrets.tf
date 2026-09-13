# Two secrets Terraform cannot originate: the webhook shared secret you
# choose and paste into the GitHub App's settings, and the App's private key,
# which GitHub generates and hands you a PEM for. Terraform can only create
# the containers and put *a* version in them, so this file bootstraps each
# with an obvious placeholder and then gets out of the way:
# lifecycle.ignore_changes means the next `terraform apply` will not stomp on
# a real value you add by hand with `gcloud secrets versions add`.
#
# That bootstrap version matters for GITHUB_WEBHOOK_SECRET, which banto only
# checks is non-empty at startup — any placeholder gets the service running.
# It also matters for GH_APP_PRIVATE_KEY, and that one needs a PEM that
# parses: banto's startup check (src/config.ts, normalisePem then
# createPrivateKey) verifies the key is readable, though not that it
# authenticates as anything. So the service starts and answers /healthz
# before you have ever talked to GitHub, and does not authenticate as your
# App until you replace it.
#
# The placeholder is generated here rather than written into this repository.
# A private key committed to a public repo trips secret scanning and push
# protection, and "it is only a throwaway" is not a distinction those tools
# make — nor one a reader skimming the file would make. tls_private_key keeps
# the key in Terraform state, which is the same place your real one would sit
# between `gcloud secrets versions add` calls, and nowhere else.

resource "google_secret_manager_secret" "banto_webhook_secret" {
  project   = var.project_id
  secret_id = "banto-webhook-secret"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "banto_webhook_secret" {
  secret      = google_secret_manager_secret.banto_webhook_secret.id
  secret_data = "replace-me-with-a-real-secret-before-installing-the-github-app"

  lifecycle {
    ignore_changes = [secret_data]
  }
}

resource "google_secret_manager_secret_iam_member" "banto_webhook_secret" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.banto_webhook_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.banto.email}"
}

resource "google_secret_manager_secret" "gh_app_key" {
  project   = var.project_id
  secret_id = "banto-gh-app-key"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "gh_app_key" {
  secret      = google_secret_manager_secret.gh_app_key.id
  secret_data = tls_private_key.gh_app_placeholder.private_key_pem

  lifecycle {
    ignore_changes = [secret_data]
  }
}

resource "google_secret_manager_secret_iam_member" "gh_app_key" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.gh_app_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.banto.email}"
}

# Replaced by a real App key added out of band; see the example's README.
resource "tls_private_key" "gh_app_placeholder" {
  algorithm = "RSA"
  rsa_bits  = 2048
}
