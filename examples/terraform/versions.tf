terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source = "hashicorp/google"
      # google_cloud_run_v2_worker_pool (needed to create the pool banto
      # manages) shipped in 6.37.0; everything else here is older than that.
      version = ">= 6.37, < 9"
    }
    # Only to generate a parseable placeholder for the GitHub App key, so no
    # private key has to live in this repository. Replaced out of band.
    tls = {
      source  = "hashicorp/tls"
      version = ">= 4.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
