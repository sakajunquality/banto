# Refresh the runner regularly; GitHub enforces runner version freshness.
# These multi-platform digests were checked on 2026-09-16.
ARG BUN_IMAGE=oven/bun:1.4.2-debian@sha256:4f6e31d1a54d6a3dd312daef655fc998101b5043d52e12592ac293ef04b9bc73
ARG RUNNER_IMAGE=ghcr.io/actions/actions-runner:latest@sha256:e5496277be5d09bc968b3d64911b74e219ac4a3f2edce956a3ecf9271bea1ef4
FROM ${BUN_IMAGE} AS bun
FROM ${RUNNER_IMAGE}
USER root
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --chown=runner:runner runner/ /opt/banto-runner/
RUN chmod 0555 /opt/banto-runner/job-started.sh
USER runner
ENTRYPOINT ["/usr/local/bin/bun", "/opt/banto-runner/entrypoint.ts"]
