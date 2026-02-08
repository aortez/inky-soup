#!/bin/bash
# Test server wrapper for e2e tests.
# Uses Rocket.toml for proper upload limits (Rocket defaults are too small).

set -euo pipefail
cd "$(dirname "$0")"

# Isolate E2E runtime data so each run starts clean and deterministic.
E2E_TMP_ROOT="$(mktemp -d /tmp/inky-soup-e2e.XXXXXX)"
export INKY_SOUP_IMAGES_DIR="${INKY_SOUP_IMAGES_DIR:-$E2E_TMP_ROOT/images}"
export INKY_SOUP_DATA_DIR="${INKY_SOUP_DATA_DIR:-$E2E_TMP_ROOT/data}"
mkdir -p "$INKY_SOUP_IMAGES_DIR" "$INKY_SOUP_DATA_DIR"

cleanup() {
  rm -rf "$E2E_TMP_ROOT"
}
trap cleanup EXIT

# Run server with reduced lock duration for faster test cycles.
RUST_LOG=debug LOCK_DURATION_SECS=3 cargo run --release 2>&1 | tee /tmp/e2e-server.log
