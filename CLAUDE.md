# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Inky Soup is a web-based image display system for Pimoroni Inky Impression e-ink screens, designed to run on Raspberry Pi Zero W. The project has three layers:

1. **Rust web server** (`upload-server/`) — Rocket-based web application for file storage, gallery management, and hardware control.
2. **Client-side JavaScript** — Web Workers for image processing (resizing, dithering) in the browser.
3. **Python display script** (`update-image.py`) — Hardware interface that flashes pre-processed images to the e-ink display.

## Architecture

### Processing Pipeline

All image processing happens **client-side** to keep the Pi Zero lightweight:

```
Browser                              Server                    Hardware
───────                              ──────                    ────────
Upload image ──────────────────────► Save original
                                     (static/images/)
       │
       ├─► Filter Worker ──────────► Save cache & thumbnail
       │   (resize 600x448)          (static/images/cache/*.png)
       │                             (static/images/thumbs/*.png)
       │
       ▼
Gallery → Click thumbnail → Detail View
       │
       ├─► Filter Worker ──────────► Optional: save new filter
       │   (adjust filter)           (static/images/cache/*.png)
       │
       ├─► Dither Worker
       │   (Floyd-Steinberg,
       │    7-color palette,
       │    adjust saturation)
       │
       ▼
Click "Flash to Display"
       │
       ├─► Upload dithered ─────────► Save dithered image
       │                              (static/images/dithered/)
       │
       └─► Submit flash job ────────► Queue job ───────────────► Background worker
                                      (returns immediately)       │
                                                                  ▼
                                      Poll /api/flash/status ◄─── Python script
                                      (track progress)            (update-image.py)
                                                                  │
                                                                  ▼
                                                            E-ink display
```

### Rust Server Modules (`upload-server/src/`)

| Module | Purpose |
|--------|---------|
| `main.rs` | Routes, forms, gallery logic, fairing setup |
| `metadata.rs` | Per-image settings (filter, saturation) stored in JSON |
| `cache_worker.rs` | Utility for cache path computation |
| `cleanup.rs` | Background task that removes orphaned files every 5 minutes |
| `flash_queue.rs` | Async flash queue system with background worker for non-blocking display updates |

### JavaScript Modules (`upload-server/static/js/`)

| File | Purpose |
|------|---------|
| `dither.js` | Floyd-Steinberg dithering for 7-color e-ink palette |
| `filters.js` | Image resampling kernels (Lanczos3, CatmullRom, Bilinear, Nearest) |
| `filter-worker.js` | Web Worker for non-blocking resize operations |
| `dither-worker.js` | Web Worker for non-blocking dither operations |

### Data Storage

```
static/images/
├── *.jpg, *.png, ...      # Original uploaded images
├── cache/
│   └── {filename}.png     # Resized images (600x448) for preview and dithering
├── thumbs/
│   └── {filename}.png     # Gallery thumbnails (150x112)
├── dithered/
│   └── {filename}.png     # Pre-dithered images ready for flashing
└── metadata.json          # Per-image settings (filter preference, saturation)
```

### Key Design Decisions

- **Client-side processing** — All resizing and dithering runs in the browser via Web Workers, keeping the Pi Zero's CPU free.
- **Async flash queue** — Flash jobs are queued and processed by a background worker, allowing the UI to return immediately and support multiple users.
- **Detail view UX** — Click a thumbnail to enter a full detail view with all controls (filter, saturation, dither preview, flash) in one place. No modal-hopping.
- **Pre-dithered flashing** — The server requires a pre-dithered PNG before flashing; Python script just sends bytes to hardware.
- **Background cleanup** — A Rocket fairing spawns a task that removes orphaned cache/dithered files every 5 minutes.
- **Cross-compilation** — Uses `cross` with Docker for ARMv6 support (Pi Zero's architecture).
- **File naming** — Cache, thumb, and dithered files are always PNG, named `{original}.png` (e.g., `photo.jpg.png`).
- **Templates** — Tera template engine; single-page app in `index.html.tera` with shared macros in `macros.html.tera`.
- **"Flash twice" option** — Overcomes e-ink ghosting by flashing the image twice.

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

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` | Main gallery page |
| `POST` | `/upload` | Upload original image |
| `POST` | `/flash` | Queue flash job (returns immediately with job_id) |
| `POST` | `/delete` | Delete image and associated cache/dithered files |
| `GET` | `/api/thumb-status/<filename>` | Check if gallery thumbnail exists |
| `GET` | `/api/flash/status` | Get current flash job and queue status (all users) |
| `GET` | `/api/flash/status/<job_id>` | Get status of specific flash job |
| `POST` | `/api/upload-cache` | Upload client-generated cache image (600x448) |
| `POST` | `/api/upload-thumb` | Upload client-generated gallery thumbnail (150x112) |
| `POST` | `/api/upload-dithered` | Upload client-generated dithered image |

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

## Python Script

The `update-image.py` script receives pre-dithered PNG images from the server and flashes them to the display.

**Dependencies:**
- `pillow` (PIL) — Image loading.
- `inky` library — Pimoroni's e-ink driver for `inky_uc8159` model.

**Usage:**
```bash
python3 update-image.py <image-path> [saturation] [--skip-dither]
```

The `--skip-dither` flag is always used now since dithering happens client-side.
