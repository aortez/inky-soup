# Server and frontend development

The Rust/Rocket server stores images, serves the browser app, and queues physical
display updates. Image resizing and dithering run in browser Web Workers.
For device builds and deployment, use the [Yocto guide](../yocto/README.md).

## Run locally

From this directory, with Rust and Node.js installed:

```bash
npm ci
cargo run --locked
```

The app listens on port 8000. Run from this directory so Rocket can find
`Rocket.toml`, `templates/`, and `static/`.

`INKY_SOUP_IMAGES_DIR` overrides image storage, which defaults to `static/images`.
The server creates `cache/`, `thumbs/`, `dithered/`, and `metadata/` beneath it.
On the Pi, storage is `/data/inky-soup/images`.

`Rocket.toml` sets a 20 MiB file upload limit and a 21 MiB multipart form limit.
The Pi runs the `inky-soup-server.service` systemd unit and invokes
`/usr/bin/inky-soup-update-display` to update the screen. That executable is not
installed by `cargo run`, so physical flash requests cannot complete on a normal
development computer.

Orientation changes require a matching server and `inky-soup-update-display`
script. For an isolated device test, set `INKY_SOUP_IMAGES_DIR` and
`INKY_SOUP_DATA_DIR` to a disposable directory, choose a different `ROCKET_PORT`,
and point `INKY_SOUP_DISPLAY_COMMAND` at the matching copied executable. Avoid
concurrent physical jobs from the normal and test servers. The
[CLI orientation command](../cli/README.md#mounting-orientation) controls either
server through its chosen `--device` URL.

The original Pi Zero W needs ARMv6 **including the linker startup objects**.
`-C target-cpu=arm1176jzf-s` alone does not fix a host cross-GCC that ships ARMv7
startup objects. The orientation preview was built with Rust 1.85.0 and a Zig
0.14.1 linker wrapper running `zig cc -target arm-linux-gnueabihf
-mcpu=arm1176jzf_s`, selected via
`CARGO_TARGET_ARM_UNKNOWN_LINUX_GNUEABIHF_LINKER`, with
`RUSTFLAGS='-C target-cpu=arm1176jzf-s'`. `readelf -A` must report ARMv6 and VFPv2;
verify startup on the Pi before replacing its installed server. Production images
continue to use the Yocto toolchain.

Orientation validation on 2026-10-25 used the original Pi Zero W and 13.3-inch
2025 display over USB Ethernet. The new app rebuilt a disposable photo at all
four angles and completed a 90° physical refresh, confirmed visually by the user.
CLI orientation, restart persistence, and prepared portrait upload/delete passed.
The normal service and its 15 photos were preserved; the temporary service was
stopped. See [results](../docs/validation/frame-orientation-pi-zero-w.json).

## Unit tests and lint

```bash
npm run lint
npm test
npm run test:watch
npm run test:coverage
cargo test --locked
```

Vitest tests live in `tests/`; coverage output is written to `coverage/` and is
ignored by Git. Rust unit tests live in the source modules. CI uses the image's
Rust 1.85.0 toolchain and Node.js 24.

Coverage totals have a known limitation: the legacy filter and dither libraries
are executed through a VM test helper and their exercised code is not attributed
by the current V8 report. Use the test results alongside the coverage report.

## Browser tests

Install Chromium once after installing npm dependencies:

```bash
npx playwright install chromium
```

On Linux, `npx playwright install --with-deps chromium` also installs the required
system libraries. The E2E suite creates and deletes images; use a disposable test
server or test device.

```bash
npm run test:e2e
```

The local Playwright configuration starts `test-server.sh` itself on port 8000,
with a short image-lock timeout. Stop an existing local server before running it.
Release compilation must finish within the configured startup timeout; build
first with `cargo build --release --locked` if needed.

The Docker environment mirrors the Pi's application and data paths:

```bash
npm run docker:build
npm run docker:up
npm run test:docker
npm run docker:down
```

`docker:down` removes the Docker test data volume. Docker does not contain the
physical display driver or hardware, so it does not validate screen output.
`./run-tests.sh` combines lint, JS unit tests, and Docker E2E tests, and removes
the Docker test volume when it exits. Rust tests are run separately.

To target a disposable Pi instead:

```bash
REMOTE_URL=http://10.55.0.1:8000 npm run test:remote
```

The remote configuration starts no server; without `REMOTE_URL`, it targets
`http://inky-soup.local:8000`.

## Hosted frame app API

The client at `https://allan.pizza/frame/` uses `GET /api/display-config`,
`GET /api/images`, the existing upload endpoints, image locks, and the flash queue.
`/api/images` returns the same metadata as the local gallery. Original and derived
image bytes still travel directly between the client and the Pi.

The server allows cross-origin requests from exactly `https://allan.pizza`.
Additional development origins can be supplied as a comma-separated
`INKY_SOUP_CLIENT_ORIGINS` environment variable, for example
`http://localhost:4173`. Origins include the scheme and port, with no trailing
slash. Restart the server after changing the environment.

All POST handlers reject foreign browser origins, including simple form requests
that do not require a preflight. The local HTTP UI and clients without an Origin
header (including the Rust CLI) continue to work. This is browser origin
protection, not authentication against other local-network clients. Do not expose
the unauthenticated device API to the internet.

The hosted app also requires the browser’s local-network permission. The tested
phone is Android Chrome; offline app editing works after its first successful
load, while connecting, fetching gallery photos, and sending require the local
frame. Bluetooth remains the WiFi provisioning transport, not the photo transport.
