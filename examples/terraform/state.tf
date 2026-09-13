# One small JSON object per pool, rewritten every few minutes (see "State" in
# the README for why GCS is the default store and what it holds).
#
# Versioning off is not enough on its own: a new bucket also has soft delete
# on by default, which retains overwritten and deleted objects for seven
# days. banto overwrites constantly, so that default would keep thousands of
# dead generations that nothing will ever read. Setting the retention to zero
# turns it off; keep the default only if you want the undelete window and are
# willing to pay for the retained bytes.
resource "google_storage_bucket" "banto_state" {
  project                     = var.project_id
  name                        = "${var.project_id}-banto-state"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Lets `terraform destroy` remove the bucket while you're experimenting
  # instead of failing on a non-empty one. Drop this once the state in it is
  # real.
  force_destroy = true

  versioning {
    enabled = false
  }

  soft_delete_policy {
    retention_duration_seconds = 0
  }
}

# Replacing an object needs create AND delete: roles/storage.objectCreator
# would let the first write of each pool through and fail every one after it.
resource "google_storage_bucket_iam_member" "banto_state_writer" {
  bucket = google_storage_bucket.banto_state.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.banto.email}"
}
