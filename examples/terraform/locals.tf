locals {
  # banto verifies the ID token itself (see "The reconcile" in the README), so
  # this is just a string both sides agree on. Keeping it off the service URL
  # avoids a service <-> scheduler dependency cycle.
  reconcile_audience = "banto-reconcile"

  # Cloud Run cannot pull from ghcr.io directly; google_artifact_registry_repository.ghcr_proxy
  # in registry.tf proxies it, preserving the upstream path. See registry.tf
  # for the verified mechanics.
  banto_image = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.ghcr_proxy.repository_id}/sakajunquality/banto@${var.banto_image_digest}"

  # One pool: default-labelled jobs land on the worker pool this example
  # creates (worker_pool.tf). Add more objects here — and more worker pools —
  # to follow the three-pool pattern in the README's own BANTO_POOLS example.
  banto_pools = [
    {
      name            = "default"
      project         = var.project_id
      location        = var.region
      workerPool      = google_cloud_run_v2_worker_pool.runners.name
      labels          = ["self-hosted", "runner-default"]
      min             = 0
      max             = 3
      warmSpare       = 0
      cooldownSeconds = 300
    },
  ]
}
