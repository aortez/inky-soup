# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Inky Soup is a web-based image display system for Pimoroni Inky Impression e-ink screens, designed to run on Raspberry Pi Zero W. The project has two core components working in tandem:

1. **Rust web server** (`upload-server/`) - Rocket-based web application for image upload, gallery management, and display control.
2. **Python display script** (`update-image.py`) - Hardware interface script that flashes images to the e-ink display.

## Architecture

### Component Interaction Flow
- User uploads image via web form → Rocket server saves to `static/images/` → Gallery updates.
- User selects image and clicks "Flash" → Server invokes `update-image.py` with image path and saturation → Python script drives e-ink hardware.
- Images are resized to 600x448 by the Python script if needed (native Inky Impression resolution).

### Key Design Decisions
- Cross-compilation from x86_64 to ARM (Pi Zero) using `cross` with Docker for proper ARMv6 support.
- The Pi Zero (original) uses ARMv6, which requires special handling - standard Debian toolchains generate ARMv7 instructions that cause illegal instruction errors.
- Server creates `static/images/` directory at startup if missing.
- File uploads limited to 10 MiB (configured in `Rocket.toml`).
- "Flash twice" option exists to overcome e-ink ghosting effects.
- Templates use Tera template engine with shared macros in `macros.html.tera`.

## Build and Development

### Local Development (x86_64)
```bash
cd upload-server
cargo check          # Check compilation
cargo build          # Build for local arch
cargo run            # Run server locally (port 8000)
cargo test           # Run tests
```

### Cross-Compilation Setup (for Pi Zero)
First-time setup (automated):
```bash
./setup-crosscompile.sh
```

This script (idempotent, safe to run multiple times):
- Checks for Docker (required for `cross`).
- Installs `cross` via cargo (Docker-based cross-compilation).
- Installs ARM target via rustup.

Manual build for Pi:
```bash
cd upload-server
cross build --release --target=arm-unknown-linux-gnueabihf
# Binary: target/arm-unknown-linux-gnueabihf/release/upload-server
```

**Why `cross` instead of `cargo`?** The Pi Zero uses ARMv6, but the standard Debian `arm-linux-gnueabihf-gcc` toolchain generates ARMv7 instructions by default. This causes "illegal instruction" (SIGILL) errors on the Pi Zero. The `cross` tool uses Docker containers with properly configured toolchains.

### Deployment
```bash
INKY_SOUP_IP=<pi-hostname-or-ip> ./deploy.sh
```

For non-default usernames:
```bash
DEPLOY_USER=oldman INKY_SOUP_IP=inky-soup.local ./deploy.sh
```

The deploy script:
- Validates prerequisites (Docker, `cross`, INKY_SOUP_IP variable).
- Builds optimized release binary using `cross` for ARM target.
- Stages binary, templates, static files, and Python script in `/tmp/inky-soup`.
- Stops the running service (if any) to unlock the binary.
- SCPs everything to Pi.
- Installs and restarts the systemd service automatically.

To build debug binary instead: `BUILD_TYPE=debug INKY_SOUP_IP=<ip> ./deploy.sh`

### SD Card Deployment
For initial setup or headless deployment via a mounted SD card:
```bash
SDCARD_ROOT=/media/user/rootfs ./deploy-sdcard.sh
```

## Known Issues

### Test File Mismatch
`src/tests.rs` contains boilerplate Rocket form validation tests that don't match this application's forms (`FormInput`, `FormOption` don't exist in the actual code). These tests aren't active but should be replaced with real integration tests for upload/flash/delete endpoints.

## Server Configuration

Rocket configuration in `upload-server/Rocket.toml`:
- Listens on `::` (all interfaces, IPv4 and IPv6).
- Port 8000 in both debug and release modes.
- File upload limit: 10 MiB (`file` limit).
- Form data limit: 11 MiB (`data-form` limit, must exceed file limit for multipart uploads).
- Template directory: `templates/`.

## Debugging

To tail logs on the remote Pi:
```bash
DEPLOY_USER=oldman INKY_SOUP_IP=inky-soup.local ./tail_remote_logs.sh
```

## Python Dependencies

The `update-image.py` script requires:
- `pillow` (PIL) for image processing.
- `inky` library (Pimoroni's e-ink driver for `inky_uc8159` model).
