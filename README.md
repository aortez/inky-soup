# Inky Soup

# Introduction
Inky Soup is automation for displaying images on the Pimoroni Inky Impression e-ink screen.
It provides users with a web page that they can use to flash images
to their Inky Impression.  

I suggest using a Pi Zero W, as it has low compute requirements and when combined with the e-ink display, it has very low power utilization (~1 watt peak).

## Web Page
![Example of Web Page](./inky-soup-uploader.png "Example of Web Page")

## Example Display Build
![Example of Inky Impression Display](./inky-soup-display.jpg "Example of Display")

![A Goose](./upload-server/static/favicon.ico "A Goose")

# Instructions

The project consists of two components:

1. A web page - this component is written in Rust using the fine library Rocket
for all the web stuff.
1. A python script for flashing the images to the screen.

## Prerequisites

**On your development machine:**
- Rust (via rustup)
- Docker (required for cross-compilation)

**On your Pi Zero:**
- Raspberry Pi OS (tested with Trixie/Bookworm)
- Python 3 with `pillow` and `inky` libraries
- SPI and I2C enabled

## Pi Zero Setup

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

## First-Time Setup (Development Machine)

Set up cross-compilation tools (only needed once):

    ./setup-crosscompile.sh

This installs `cross`, a Docker-based cross-compilation tool that properly supports
the Pi Zero's ARMv6 architecture.

## Deploy to Your Pi

Use the deploy script to build and deploy to your Pi:

    INKY_SOUP_IP=<your Pi's IP or hostname> ./deploy.sh

For non-default usernames (default is `pi`):

    DEPLOY_USER=oldman INKY_SOUP_IP=inky-soup.local ./deploy.sh

This builds an optimized release binary, deploys it to your Pi, and automatically restarts the service.

To enable the service on first deployment (so it starts on boot):

    ssh <your-pi> "sudo systemctl enable inky-soup.service"

Now, visit your Pi in a web browser (port 8000) over your local network and start uploading images!

To tail logs on the remote Pi:

    DEPLOY_USER=oldman INKY_SOUP_IP=inky-soup.local ./tail_remote_logs.sh

## SD Card Deployment

For initial setup or when the Pi isn't on the network, use the SD card deploy script:

    SDCARD_ROOT=/media/user/rootfs ./deploy-sdcard.sh

This copies files directly to a mounted SD card via a remote machine (useful for headless setup).

# TODO

## Basic
* add validator for image types
* logging

## Image Gallery
* Hard code some limit to how many pictures can be uploaded?
* Some kind of confirmation dialog for the delete button?

## Image Rotation
* [ ] Add a way to show a random image at a fixed interval.
* [ ] Add a way to rotate images in sequential order.
* [ ] Add a way to configure the change interval.

## Advanced
* preview image before flashing? allow user to crop interactively?
