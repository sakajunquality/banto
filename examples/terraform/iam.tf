# Three identities:
#   - banto itself (google_service_account.banto), attached to the Cloud Run
#     service in service.tf;
#   - the Cloud Scheduler job that calls /reconcile (banto_scheduler), whose
#     email goes into BANTO_RECONCILE_ALLOWED_EMAILS; and
#   - the runner pool's own identity (runner), which banto never assumes —
#     grant it whatever your runner image needs (for example, Secret Manager
#     access to fetch its own registration token), which is outside banto's
#     concern and outside this example.

resource "google_service_account" "banto" {
  project      = var.project_id
  account_id   = "banto-autoscaler"
  display_name = "banto — GitHub Actions runner pool autoscaler"
}

resource "google_service_account" "banto_scheduler" {
  project      = var.project_id
  account_id   = "banto-scheduler"
  display_name = "Calls banto /reconcile"
}

resource "google_service_account" "runner" {
  project      = var.project_id
  account_id   = "gh-runner-default"
  display_name = "Identity of the runner pool banto manages"
}

# Exactly the two permissions banto uses (see "IAM" in the README), instead of
# roles/run.developer. Lowercase, matching gcloud's own permission names —
# run.workerPools.get/run.workerPools.update (the REST path's casing) fails to
# create the role; confirmed against a live project.
#
# This role is project-scoped, and creating one needs iam.roles.create on
# var.project_id — a permission the identity running `terraform apply` may
# not have (many CI service accounts don't). If it fails for that reason,
# delete this resource and google_project_iam_member.banto_scaler below, and
# grant roles/run.developer to google_service_account.banto instead:
#
#   resource "google_project_iam_member" "banto_scaler_fallback" {
#     project = var.project_id
#     role    = "roles/run.developer"
#     member  = "serviceAccount:${google_service_account.banto.email}"
#   }
#
# roles/run.developer also grants control over Cloud Run services, jobs and
# revisions project-wide — a real cost, not just a formality, which is why the
# custom role is the default here.
resource "google_project_iam_custom_role" "worker_pool_scaler" {
  project     = var.project_id
  role_id     = "workerPoolScaler"
  title       = "Worker pool scaler"
  permissions = ["run.workerpools.get", "run.workerpools.update"]
}

resource "google_project_iam_member" "banto_scaler" {
  project = var.project_id
  role    = google_project_iam_custom_role.worker_pool_scaler.id
  member  = "serviceAccount:${google_service_account.banto.email}"
}

# Not granted by default: Google's manual-scaling guide lists
# roles/iam.serviceAccountUser on the worker pool's own service account among
# the roles for changing instance counts. banto's PATCH carries
# updateMask=scaling and never touches the template, which is a reason to
# expect actAs not to be required — but that has not been verified against a
# live project (see the README's IAM section). Uncomment if an actAs error
# says otherwise:
#
# resource "google_service_account_iam_member" "banto_actas_runner" {
#   service_account_id = google_service_account.runner.name
#   role                = "roles/iam.serviceAccountUser"
#   member              = "serviceAccount:${google_service_account.banto.email}"
# }

# The webhook endpoint is public by necessity; the signature plus the
# installation check protect it, and /reconcile verifies its own OIDC token
# because IAM cannot cover one path of a public service (see "The reconcile").
#
# This binding is the ordinary way to make a Cloud Run service public, and it
# is what the example uses. It does not work everywhere.
#
# If your project is under an organisation policy for domain restricted
# sharing, granting a role to `allUsers` is rejected outright — Google's own
# guidance says these instructions "won't succeed" there, and points at
# disabling the invoker IAM check instead: "use this solution when the
# project is subject to the domain restricted sharing constraint in an
# organization policy."
#
# In that case, delete this resource and set the following on the service in
# service.tf, which makes it public with no allUsers member at all:
#
#   invoker_iam_disabled = true
#
# Either way the whole service is public. Cloud Run IAM is a property of the
# service, not of a path, so /reconcile cannot be protected this way and
# verifies its own OIDC token instead — see "The reconcile" in the README.
resource "google_cloud_run_v2_service_iam_member" "public" {
  project  = google_cloud_run_v2_service.banto.project
  location = google_cloud_run_v2_service.banto.location
  name     = google_cloud_run_v2_service.banto.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
