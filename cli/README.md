# Local frame client

`inky-cli` controls the frame through the same HTTP API as the browser, over USB
Ethernet or local WiFi. It does not need SSH or a browser. The host client is a
separate crate, tested with Rust 1.94.1; the device server remains on Rust 1.85.0.

From the repository root:

```bash
./inky-cli status
./inky-cli display --json
./inky-cli --device http://inky-soup.local:8000 images
```

The wrapper builds on first use. To install a standalone executable:

```bash
cargo install --locked --path cli
inky-cli --help
```

`--device` or `INKY_SOUP_URL` selects the device. The default is
`http://10.55.0.1:8000` (USB Ethernet). Hostnames without a port use 8000.
WiFi uses `http://inky-soup.local:8000` or the Pi’s local IP address.

## Photos and display jobs

```bash
# Store an original; prepare and send it using the browser editor afterward.
./inky-cli upload photo.jpg

# Upload an already processed PNG, generate a thumbnail, and refresh the display.
./inky-cli upload screen.png --prepared --flash --wait

# Use the exact filename returned by `images` for an existing prepared image.
./inky-cli flash 01234567-example.png --wait --timeout 180

# Recover after an interrupted connection without submitting another refresh.
./inky-cli status --json
./inky-cli job 7 --wait --json
```

Prepared PNGs must be opaque and match the device’s exact width and height. Native
colors are black, white, yellow, red, blue, and green; the 5.7-inch display also
supports orange (255, 140, 0). The CLI validates these properties before uploading.
It does not resize or dither ordinary photos. Prepared uploads save the supplied
PNG as the original, cache, and dithered image, plus a generated thumbnail.
Uploads receive a unique filename and use the device’s image locks for derived
files and flash submission.

`--wait` polls an existing job and exits nonzero on a reported failure or timeout.
A timeout does not cancel the device job. An interrupted flash submission may have
reached the frame: inspect `status` before deciding to submit again. Job IDs reset
when the server restarts; active waits also check the filename and creation time.
A fresh `job` command cannot identify a job from a previous server lifetime.

`--json` writes one JSON result to stdout and progress to stderr. Operational
errors produce an `error` object and exit status 1; argument errors use Clap’s
normal help/error output. Without `--json`, results are pretty-printed JSON.

The device API is intended for a trusted local network; it has no client
authentication. `images` requires the new `/api/images` endpoint. Other commands
use existing endpoints. The CLI never installs firmware or changes WiFi settings.

## Checks

```bash
cargo fmt --manifest-path cli/Cargo.toml --check
cargo test --locked --manifest-path cli/Cargo.toml
```

Tests cover URL validation, native-palette validation, multipart filenames,
structured output, failed jobs, and polling without resubmission. The client has
also been exercised against the original Pi Zero W over USB and WiFi.
