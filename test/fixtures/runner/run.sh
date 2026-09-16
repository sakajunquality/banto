#!/bin/sh
set -eu
test "$1" = "--jitconfig"
test "$2" = "one-job-secret"
test -z "${BANTO_JIT_CONFIG-}"
case "$BANTO_TEST_MODE" in
  busy)
    sh "$ACTIONS_RUNNER_HOOK_JOB_STARTED"
    sleep 2
    exit 23
    ;;
  idle)
    trap 'exit 0' INT TERM
    while :; do sleep 0.05; done
    ;;
  failure) exit 13 ;;
  *) exit 78 ;;
esac
