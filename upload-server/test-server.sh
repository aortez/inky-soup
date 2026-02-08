#!/bin/bash
# Test server wrapper for e2e tests.
# Uses Rocket.toml for proper upload limits (Rocket defaults are too small).

set -e
cd "$(dirname "$0")"

# Run server with reduced lock duration for faster test cycles.
RUST_LOG=debug LOCK_DURATION_SECS=3 cargo run --release 2>&1 | tee /tmp/e2e-server.log
