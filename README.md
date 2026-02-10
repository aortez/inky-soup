# Inky Soup

## Intro
Inky Soup is automation for displaying images on the Pimoroni Inky Impression e-ink screen.
It provides users with a web app that they can use to flash images to their Inky Impression.

![Example of Web Page](./inky-soup-uploader.png "Example of Web Page")

I suggest using a Pi Zero W, as it has low compute requirements and when combined with the e-ink display, it has very low power utilization (~1 watt peak).

The web app mostly keeps computation client side and maintains caches to avoid recomputing things.

It provides a nice gallery for viewing/managing/processing and of course flashing your images.

## Example Display Build

![Example of Inky Impression Display](./inky-soup-display.jpg "Example of Display")

![A Goose](./upload-server/static/favicon.ico "A Goose")

# Instructions

The project consists of two components:

1. A web page - this component is written in Rust using the fine library Rocket
for all the web stuff.
1. A python script for flashing the images to the screen.

**Recommended:** Deploy using the Yocto image + tools under `yocto/` (includes fast app-only deploy via `npm run yolo -- --fast`). See `yocto/README.md`.

## Prerequisites

**On your development machine:**
- Rust (via rustup)
- Node.js (for `upload-server/` tests and `yocto/` tooling)

**On your device:**
- Yocto image from this repo (recommended) or Raspberry Pi OS (legacy)

## Deploy (Yocto)

See `yocto/README.md` for full details. Typical workflow:

```bash
cd yocto
npm install          # First time only
npm run build        # Build image
npm run flash        # Flash to SD card (interactive)

# After the device is flashed and on the network:
npm run yolo -- --fast  # Fast deploy (app-only, no reboot)
```

Fast deploy updates `/usr/bin/inky-soup-server` plus `/usr/share/inky-soup/{static,templates}` and restarts `inky-soup-server.service`.

## Legacy: Raspberry Pi OS Setup

If you're not using the Yocto image, you can still run on Raspberry Pi OS with the Python Inky stack.

Enable SPI and I2C in `/boot/firmware/config.txt`:

```
dtparam=i2c_arm=on
dtparam=spi=on
dtoverlay=spi0-0cs
```

Install Python dependencies on the Pi:

```bash
sudo apt-get install -y python3-pil python3-numpy python3-spidev python3-smbus2
pip3 install --break-system-packages inky
```

## Development & Testing

### Running the Test Suite

The project includes a test suite with linting, unit tests, and E2E tests:

    cd upload-server
    ./run-tests.sh

This script runs:
1. **ESLint** - Code style checks (Airbnb config)
2. **Unit tests** (Vitest) - JavaScript functions and modules
3. **E2E tests** (Playwright) - Complete user workflows

### Manual Testing

**Start the development server:**

    cd upload-server
    cargo run

**Run individual test suites:**

    cd upload-server
    npm run lint         # Code style only
    npm test             # Unit tests only
    npm run test:e2e     # E2E tests only (requires server running)

**Frontend development:**

    npm install          # First time only
    npm run lint:fix     # Auto-fix style issues

See [JS_STYLE_GUIDE.md](./JS_STYLE_GUIDE.md) for JavaScript conventions.

# TODO

## FIX
- [ ] If viewing a read-only instance of a Details page and the edit instance deletes the image, the the read-only viewer should get notified via a modal dialog that, once confirmed, takes them back to the gallery

## Image Gallery
- [ ] Arbitrary hard limit on number of uploaded images.

## Image Rotation
- [ ] Show a random image at a fixed interval.
- [ ] Allow user to assign values to each image's likely hood of being in the rotation.  The default value is zero.
- [ ] Configure the change interval.

## Advanced
- [ ] Remember last image parameters and re-use - allows users to tune already showing image! (consider user stories here)
- [ ] Interactive cropping sometime before flashing... when?
