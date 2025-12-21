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

### JavaScript Architecture (`upload-server/static/js/`)

The frontend uses **ES6 modules** with a clean separation of concerns:

```
static/js/
├── main.js                    # Entry point, initialization, window exports
├── core/                      # Foundation (no dependencies)
│   ├── constants.js          # Configuration constants
│   ├── state.js              # Centralized state management
│   └── dom.js                # Cached DOM element references
├── services/                  # Business logic (depends on core)
│   ├── api-client.js         # All server API calls
│   ├── image-loader.js       # Image loading and caching
│   ├── filter-service.js     # Filter processing with Web Workers
│   ├── dither-service.js     # Dithering with Web Workers
│   ├── flash-service.js      # Flash job management and polling
│   └── upload-service.js     # File upload and thumbnail generation
├── ui/                        # UI components (depends on core + services)
│   ├── navigation.js         # View switching and history
│   ├── detail-view.js        # Detail view management
│   ├── gallery-view.js       # Gallery and thumbnail polling
│   ├── filter-controls.js    # Filter button handlers
│   ├── saturation-controls.js # Saturation slider
│   ├── flash-status.js       # Flash status bar and modal
│   ├── upload-ui.js          # Upload drop zone and modal
│   └── delete-ui.js          # Delete confirmation modal
├── utils/                     # Pure utility functions
│   └── formatters.js         # Display formatters (size, speed, time)
└── lib/                       # External libraries (legacy IIFE pattern)
    ├── filters.js            # Image resampling kernels
    ├── dither.js             # Floyd-Steinberg dithering
    ├── filter-worker.js      # Web Worker for non-blocking resize
    └── dither-worker.js      # Web Worker for non-blocking dither
```

**Dependency Hierarchy:** Core → Services → UI → Main

**Key Features:**
- Clean module boundaries with single responsibilities
- Centralized state management (no scattered globals)
- DOM elements cached once on initialization
- All functions independently testable
- ESLint enforced code style (Airbnb base config)

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
- **Centralized state management** — Single source of truth in `core/state.js`.
- **Async flash queue** — Flash jobs are queued and processed by a background worker, allowing the UI to return immediately and support multiple users.
- **Detail view UX** — Click a thumbnail to enter a full detail view with all controls (filter, saturation, dither preview, flash) in one place. No modal-hopping.
- **Pre-dithered flashing** — The server requires a pre-dithered PNG before flashing; Python script just sends bytes to hardware.
- **Background cleanup** — A Rocket fairing spawns a task that removes orphaned cache/dithered files every 5 minutes.
- **Cross-compilation** — Uses `cross` with Docker for ARMv6 support (Pi Zero's architecture).
- **File naming** — Cache, thumb, and dithered files are always PNG, named `{original}.png` (e.g., `photo.jpg.png`).
- **Templates** — Tera template engine; single-page app in `index.html.tera` with shared macros in `macros.html.tera`.
- **"Flash twice" option** — Overcomes e-ink ghosting by flashing the image twice.
- **Test coverage** — Comprehensive testing with Vitest (unit), Playwright (E2E), and ESLint (code quality).

## Build and Development

### Local Development (x86_64)

**Rust server:**
```bash
cd upload-server
cargo check          # Check compilation
cargo build          # Build for local arch
cargo run            # Run server locally (port 8000)
cargo test           # Run Rust tests
```

**JavaScript frontend:**
```bash
cd upload-server
npm install          # Install dependencies (first time only)
npm test             # Run unit tests (Vitest)
npm run lint         # Check code style (ESLint)
npm run lint:fix     # Auto-fix code style issues
npm run test:e2e     # Run E2E tests (requires server running)
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

## Testing

### Run All Tests

The easiest way to run all tests is with the all-in-one test runner:

```bash
cd upload-server
./run-tests.sh
```

This script runs ESLint, unit tests, starts the server, runs E2E tests, stops the server, and cleans up test artifacts. It exits with a non-zero status if any tests fail.

### Individual Test Commands

For running specific test suites during development:

### Unit Tests (Vitest)

Located in `upload-server/tests/`, unit tests cover isolated functions and modules.

```bash
cd upload-server
npm test              # Run all unit tests
npm run test:watch   # Run tests in watch mode
npm run test:coverage # Run with coverage report
```

**Current unit tests:**
- `tests/filters.test.js` - Image resampling filter kernels (25 tests)
- `tests/dither.test.js` - Floyd-Steinberg dithering algorithm (23 tests)
- `tests/utils/formatters.test.js` - Display formatters (11 tests)

**Configuration:** `vitest.config.js` with Node environment and ImageData polyfill in `tests/setup.js`

### E2E Tests (Playwright)

Located in `e2e/`, end-to-end tests verify the entire application workflow.

```bash
cd upload-server
npm run test:e2e        # Run E2E tests (requires running server)
npm run test:e2e:ui     # Run with Playwright UI
npm run test:e2e:headed # Run in headed browser mode
```

**Current E2E tests:**
- `e2e/gallery.spec.js` - Gallery view, drop zone, navigation
- `e2e/pipeline.spec.js` - Detail view, filters, saturation, flash controls
- `e2e/upload.spec.js` - File upload workflow and progress tracking

**Important:** E2E tests require the server to be running (`cargo run`) before execution.

### Docker Testing

Run tests against a Docker container that mirrors production paths:

```bash
cd upload-server
npm run docker:build   # Build container
npm run docker:up      # Start container
npm run test:docker    # Run E2E tests against Docker (localhost:8000)
npm run docker:down    # Stop and clean up
```

The Docker environment uses `/data/inky-soup/images` for image storage, matching the Yocto production setup. This ensures path handling works identically in dev and prod.

### Remote Testing

Run tests against a deployed Pi:

```bash
cd upload-server
npm run test:remote    # Tests against inky-soup.local:8000
REMOTE_URL=http://other-pi.local:8000 npm run test:remote
```

### Code Quality (ESLint)

ESLint with Airbnb style guide enforces consistent code quality.

```bash
cd upload-server
npm run lint         # Check code style
npm run lint:fix     # Auto-fix formatting issues
```

**Configuration:** `.eslintrc.json` with Airbnb base config and browser environment.

## Known Issues

### Rust Test File Mismatch
`src/tests.rs` contains boilerplate Rocket form validation tests that don't match this application's forms (`FormInput`, `FormOption` don't exist in the actual code). These tests aren't active but should be replaced with real integration tests for upload/flash/delete endpoints.

## Server Configuration

Rocket configuration in `upload-server/Rocket.toml`:
- Listens on `::` (all interfaces, IPv4 and IPv6).
- Port 8000 in both debug and release modes.
- File upload limit: 20 MiB (`file` limit).
- Form data limit: 21 MiB (`data-form` limit, must exceed file limit for multipart uploads).
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

## Yocto Build System

Inky Soup includes a Yocto-based build system for Raspberry Pi Zero 2 W.

**Current status**: Basic bootable image with NetworkManager, SSH, and WiFi support.

**See `yocto/README.md` for complete documentation.**

### Quick Start

```bash
cd yocto
npm install          # First time only

# Set up WiFi credentials (first time only)
cp pi-base/scripts/wifi-creds.local.example wifi-creds.local
# Edit wifi-creds.local with your SSID and password

# Build and flash
npm run build        # Build image (~20 min with cache, ~2 hours first time)
npm run flash        # Flash to SD card with SSH key and WiFi injection
```

### Current Features

- **Target**: Raspberry Pi Zero 2 W (ARMv7, cortex-a7)
- **Networking**: NetworkManager with nmtui/nmcli, WiFi firmware (BCM43436)
- **Access**: SSH with key-based auth, root user with empty password (debug-tweaks)
- **Image format**: rpi-sdimg (standard Pi SD card image)
- **Flash script**: Interactive SD card flasher with SSH key injection
- **WiFi**: Credential injection at flash time, persistent across reflashes
- **mDNS**: Avahi for `<hostname>.local` discovery

### Architecture

Uses [KAS](https://kas.readthedocs.io/) for reproducible Yocto builds. All configuration in `kas-inky-soup.yml`.

### YOLO Updates (Over-the-Air)

For updating a running Pi over the network:

```bash
cd yocto
npm run yolo                # Build + push + flash + reboot
npm run yolo -- --dry-run   # Show what would happen
npm run yolo -- --skip-build # Push existing image only
```

Uses A/B partitions for safe atomic updates. If it fails, pull the disk and reflash.

### Next Steps

1. Integrate inky-soup server and display script into Yocto image
