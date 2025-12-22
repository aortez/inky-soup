#!/bin/bash
# Test server wrapper: runs server without Rocket.toml to match production.
# Restores Rocket.toml on exit even if server crashes.

set -e
cd "$(dirname "$0")"

# Hide Rocket.toml to match production (no config file deployed).
mv -f Rocket.toml Rocket.toml.hidden 2>/dev/null || true

# Ensure Rocket.toml is restored on exit.
trap 'mv -f Rocket.toml.hidden Rocket.toml 2>/dev/null || true' EXIT INT TERM

# Run server.
RUST_LOG=debug LOCK_DURATION_SECS=3 cargo run --release 2>&1 | tee /tmp/e2e-server.log
