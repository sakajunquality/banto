# The worker pool banto manages: a Cloud Run pull-based workload running
# var.runner_image, staffed by ephemeral GitHub Actions runners. Terraform
# creates it and hands it to banto; from then on banto is the one changing
# manual_instance_count, not Terraform (see lifecycle below and "Deploying" /
# "Known limitations" in the README).
#
# manual_instance_count starts at 0 deliberately: with min = 0 in
# local.banto_pools, the pool should sit idle until real demand exists, and 0
# is a value ignore_changes can start from without contradicting that.
resource "google_cloud_run_v2_worker_pool" "runners" {
  project             = var.project_id
  name                = "gh-runner-default"
  location            = var.region
  deletion_protection = false # so `terraform destroy` works while you're trying this out

  template {
    service_account = google_service_account.runner.email

    containers {
      image = var.runner_image
    }
  }

  scaling {
    manual_instance_count = 0
  }

  # Otherwise the next `terraform apply` puts the count back to whatever is
  # configured above and fights banto for it — banto's own writes and
  # Terraform's reconciliation would alternate forever. See "Deploying" in
  # the README.
  lifecycle {
    ignore_changes = [scaling[0].manual_instance_count]
  }
}
