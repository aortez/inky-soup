# Architecture and implementation notes

Read [AGENTS.md](AGENTS.md) for repository conventions,
[upload-server/README.md](upload-server/README.md) for development and tests, and
[yocto/README.md](yocto/README.md) for device builds and deployment. Those guides
are the command references; this file explains the implementation.

## Components

1. `upload-server/`: Rust/Rocket server, Tera templates, and browser JavaScript.
2. `update-image.py`: Python display driver entry point. The Yocto recipe packages
   a copy from `yocto/meta-inky-soup/recipes-inky-soup/inky-soup-display/files/` as
   `/usr/bin/inky-soup-update-display`. Keep both copies aligned when changing it.
3. `yocto/`: KAS image definitions and deployment helpers, with shared
   infrastructure in the `pi-base` submodule.

Images target Pi Zero W (ARMv6) and Zero 2 W (32-bit ARMv7 userspace). Display
support includes 5.7-inch Inky Impression (600 × 448) and the 13.3-inch 2025 model
(1600 × 1200). `GET /api/display-config` supplies display and thumbnail dimensions
from `/etc/inky-soup/display.conf`, with defaults when the file is absent.

## Image pipeline

1. The browser uploads the original image.
2. A browser filter worker resizes it to display dimensions and produces cache and
   thumbnail PNGs, which are uploaded to the server.
3. The detail view applies fit mode, filter, saturation, brightness, contrast, and
   dithering settings. Metadata is saved per image.
4. The browser uploads a pre-dithered PNG before submitting a flash request.
5. The server queues the request; its worker invokes the Python script with
   `--skip-dither`. The browser polls status while the display updates.

Processing stays in the browser to reduce work on the Pi Zero. The server does
not provide a fallback for missing pre-dithered assets. The optional second flash
runs the display script twice to reduce ghosting.

## Rust modules

- `main.rs`: routes, forms, display configuration, application state, startup.
- `config.rs`: image directories and path construction.
- `metadata.rs`: per-image settings, validation, migration, atomic JSON writes.
- `image_locks.rs`: editing sessions and lock expiry.
- `flash_queue.rs`: queue, job status/history, background display worker.
- `cache_worker.rs`: cache path helper.
- `cleanup.rs`: periodic cleanup of orphaned derived files.

Unit tests currently live in `flash_queue.rs`. The old `src/tests.rs` file is
unused Rocket example code, not an active integration suite.

## JavaScript architecture

Follow [JS_STYLE_GUIDE.md](JS_STYLE_GUIDE.md). Dependencies flow from `core/`
through `services/` and `ui/` to `main.js`.

- `core/state.js`: shared application state and settings.
- `core/dom.js`: cached DOM lookups.
- `core/constants.js`: initial display dimensions and processing constants.
- `services/`: API calls, image loading, upload queue, filtering, dithering,
  flashing.
- `ui/`: navigation, gallery/detail views, controls, upload/delete interactions.
- `utils/`: formatting, UUIDs, and image helpers.

The filter/dither libraries and worker scripts are currently directly under
`static/js/`, alongside the ES modules. Use the actual source layout when editing
imports; there is no `static/js/lib/` directory.

## Storage

`INKY_SOUP_IMAGES_DIR` selects the storage root. It defaults to `static/images`
for local runs and is `/data/inky-soup/images` in the image and Docker environment.

```text
images/
├── photo.jpg                 original
├── cache/photo.jpg.png       resized image
├── thumbs/photo.jpg.png      gallery thumbnail
├── dithered/photo.jpg.png    display-ready output
└── metadata/photo.jpg.json   per-image settings
```

Derived images are always PNGs named `{original}.png`. Metadata contains filter,
fit mode, saturation, brightness, contrast, dithering algorithm, and cache version.
The legacy shared metadata file is migrated to per-image files on startup.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/` | Gallery page |
| GET | `/api/display-config` | Display and thumbnail dimensions |
| POST | `/upload` | Store an original image |
| POST | `/delete` | Delete original and associated data |
| POST | `/api/upload-cache` | Store resized output and settings |
| POST | `/api/upload-thumb` | Store thumbnail |
| POST | `/api/upload-dithered` | Store display-ready image and settings |
| GET | `/api/thumb-status/<filename>` | Thumbnail readiness |
| POST | `/api/lock-image` | Acquire an editing lock |
| POST | `/api/unlock-image` | Release an editing lock |
| POST | `/flash` | Enqueue a display update |
| GET | `/api/flash/status` | Current job and queue |
| GET | `/api/flash/status/<job_id>` | Individual job status |

Display mounting orientation/settings and favorites-based scheduling are tracked
in issues #3 and #4. The settings implementation is parked in PR #5 and is not
part of `main` yet.

## Runtime and deployment

The Yocto app unit is `inky-soup-server.service`, running as `inky` from
`/usr/share/inky-soup`. The image also installs the display script, Python
libraries, SSH, NetworkManager, and mDNS. The image recipe creates the `inky` user
with key-based SSH access and passwordless sudo.

Root filesystem slots A and B share the boot and `/data` partitions. The current
A/B updater replaces only the inactive rootfs; kernel/firmware/boot configuration
changes require a separate matching boot update. Do not describe it as automatic
rollback. Follow the prerequisites in the deployment guide.

The USB gadget uses `dwc2`/`g_ether`, a stable pair of board-derived MAC addresses,
and a packaged NetworkManager profile. Pi USB IPv4 is `10.55.0.1/24`; the host is
`10.55.0.2/24`. WiFi keeps the default route. USB profiles live under `/usr/lib`
so the persistent `/etc/NetworkManager/system-connections` bind mount cannot hide
them. A timer checks ARP/received traffic and reloads `g_ether` for a stalled link.

Use the explicit USB IP to verify the transport; mDNS can resolve to WiFi instead.
The USB setup and diagnostics are documented in the Yocto guide.

## Bluetooth provisioning

The shared `yocto/pi-base/wifi-provisioner` daemon implements Improv BLE. Its
recipe pins the daemon source separately from the submodule revision: update
both when taking provisioner changes. Inky's recipe append sets the success URL
port to 8000. The client lives in the standalone `aortez.github.io` checkout under
`setup/`, published at https://allan.pizza/setup/; `/wifi/` redirects there.

The setup window is closed when already connected, and bounded to five minutes
when opened. Use `wifi-provisioner --start|--stop|--status` over USB/SSH. The client
handles explicit notifications and polls older firmware as a compatibility path.
