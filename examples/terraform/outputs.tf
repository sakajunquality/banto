output "banto_url" {
  value       = google_cloud_run_v2_service.banto.uri
  description = "Set this + \"/webhook\" as the GitHub App's Webhook URL (see \"Pointing a GitHub App at it\" in the README)."
}

output "banto_service_account" {
  value       = google_service_account.banto.email
  description = "The identity banto runs as."
}

output "runner_worker_pool" {
  value       = google_cloud_run_v2_worker_pool.runners.name
  description = "The worker pool banto scales. Its manual_instance_count is intentionally left to banto after the first apply — see worker_pool.tf."
}

output "banto_image" {
  value       = local.banto_image
  description = "The image address actually deployed, proxied through registry.tf."
}
