#!/bin/sh

set -eu

label="${1:?package-install label is required}"
shift

log_file="$(mktemp /tmp/r-package-install.XXXXXX.log)"
heartbeat_pid=''

cleanup() {
  if [ -n "$heartbeat_pid" ]; then
    kill "$heartbeat_pid" 2>/dev/null || true
    wait "$heartbeat_pid" 2>/dev/null || true
  fi
  rm -f "$log_file"
}
trap cleanup 0 1 2 15

(
  while sleep 60; do
    printf '[r-image] %s installation is still running.\n' "$label"
  done
) &
heartbeat_pid="$!"

if R_MAKEVARS_USER=/root/.R/Makevars MAKEFLAGS=-j1 Rscript "$@" >"$log_file" 2>&1; then
  status=0
else
  status="$?"
fi

# install.packages() can report a failed source package only as an R warning and
# still exit zero. Promote those known failure markers so the diagnostic tail is
# emitted immediately instead of relying only on the later package-load gate.
if [ "$status" -eq 0 ] && grep -Eq '^ERROR:|non-zero exit status' "$log_file"; then
  status=1
fi

kill "$heartbeat_pid" 2>/dev/null || true
wait "$heartbeat_pid" 2>/dev/null || true
heartbeat_pid=''

if [ "$status" -ne 0 ]; then
  printf '[r-image] %s installation failed; final diagnostics follow.\n' "$label" >&2
  grep -E '^ERROR:|non-zero exit status' "$log_file" >&2 || true
  tail -n 200 "$log_file" >&2
  exit "$status"
fi

grep -E '^\* DONE \(' "$log_file" || true
printf '[r-image] %s installation completed.\n' "$label"
