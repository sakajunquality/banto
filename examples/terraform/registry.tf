# Cloud Run's v2 API only accepts an image from Docker Hub, Artifact Registry
# or Container Registry (Container.image in the REST reference) — ghcr.io is
# none of those, so it cannot be given to Cloud Run directly. A remote
# repository proxies it: this one forwards every pull to ghcr.io and keeps the
# upstream path, so the published image ends up addressable as
# "<region>-docker.pkg.dev/<project>/<repo>/sakajunquality/banto@sha256:...",
# assembled in locals.tf as local.banto_image. Confirmed against a real
# project: the proxied path is exactly the upstream path, not renamed.
resource "google_artifact_registry_repository" "ghcr_proxy" {
  project       = var.project_id
  location      = var.region
  repository_id = "ghcr-proxy"
  description   = "Proxies ghcr.io so Cloud Run can pull banto (and anything else published there) by digest"
  format        = "DOCKER"
  mode          = "REMOTE_REPOSITORY"

  remote_repository_config {
    description = "ghcr.io upstream"

    # common_repository is the current field for a custom upstream URI;
    # docker_repository.custom_repository does the same thing but is
    # deprecated in favor of this one.
    common_repository {
      uri = "https://ghcr.io"
    }
  }
}
