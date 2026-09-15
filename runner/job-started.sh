#!/bin/sh
set -eu
: "${BANTO_JOB_STARTED_FILE:?missing supervisor state path}"
: > "$BANTO_JOB_STARTED_FILE"
