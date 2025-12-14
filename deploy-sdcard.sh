#!/bin/bash
#
# Builds and deploys the project to an SD card mounted on a remote machine.
# Useful when you can't SSH directly to the Pi (e.g., flashing a fresh image).

set -euo pipefail

# Configuration - override these with environment variables.
REMOTE_HOST="${REMOTE_HOST:-oldman@oldman-thinkpad.local}"
SDCARD_ROOT="${SDCARD_ROOT:-}"  # Must be set, e.g., /media/oldman/rootfs
DEPLOY_TEMP_DIR=/tmp/inky-soup
BUILD_TYPE="${BUILD_TYPE:-release}"

print_usage() {
    echo "Usage: SDCARD_ROOT=<mount-path> ./deploy-sdcard.sh"
    echo ""
    echo "Environment variables:"
    echo "  SDCARD_ROOT   - Path to SD card root partition on remote host (required)"
    echo "  REMOTE_HOST   - Remote host with SD card (default: oldman@oldman-thinkpad.local)"
    echo "  BUILD_TYPE    - 'release' or 'debug' (default: release)"
    echo ""
    echo "Example:"
    echo "  SDCARD_ROOT=/media/oldman/rootfs ./deploy-sdcard.sh"
}

check_prerequisites() {
    echo "Checking prerequisites..."

    if [ -z "${SDCARD_ROOT:-}" ]; then
        echo "ERROR: SDCARD_ROOT environment variable not set."
        print_usage
        exit 1
    fi

    if ! rustup target list --installed | grep -q arm-unknown-linux-gnueabihf; then
        echo "ERROR: ARM target not installed."
        echo "Run: ./setup-crosscompile.sh"
        exit 1
    fi

    if ! command -v arm-linux-gnueabihf-gcc &> /dev/null; then
        echo "ERROR: ARM GCC linker not found."
        echo "Run: ./setup-crosscompile.sh"
        exit 1
    fi

    # Check remote host is reachable.
    if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$REMOTE_HOST" "true" 2>/dev/null; then
        echo "ERROR: Cannot connect to $REMOTE_HOST"
        echo "Make sure SSH key auth is set up: ssh-copy-id $REMOTE_HOST"
        exit 1
    fi

    # Check SD card is mounted.
    if ! ssh "$REMOTE_HOST" "[ -d '$SDCARD_ROOT' ]"; then
        echo "ERROR: $SDCARD_ROOT not found on $REMOTE_HOST"
        echo "Is the SD card mounted?"
        exit 1
    fi

    echo "✓ Prerequisites OK"
}

check_prerequisites

# Prepare local staging directory.
echo "Preparing deployment directory..."
rm -rf $DEPLOY_TEMP_DIR
mkdir -p $DEPLOY_TEMP_DIR

# Stage service script.
cp inky-soup.service $DEPLOY_TEMP_DIR

# Build upload server.
echo "Building upload server ($BUILD_TYPE mode) for ARM..."
cd upload-server
if [ "$BUILD_TYPE" = "release" ]; then
    cargo build --release --target=arm-unknown-linux-gnueabihf
    cp target/arm-unknown-linux-gnueabihf/release/upload-server $DEPLOY_TEMP_DIR
else
    cargo build --target=arm-unknown-linux-gnueabihf
    cp target/arm-unknown-linux-gnueabihf/debug/upload-server $DEPLOY_TEMP_DIR
fi
echo "✓ Build complete"

# Copy static files and templates.
cp -ra static $DEPLOY_TEMP_DIR
cp -ra templates $DEPLOY_TEMP_DIR
cp -ra Rocket.toml $DEPLOY_TEMP_DIR
cd ..

# Copy over image update python script.
cp ./update-image.py $DEPLOY_TEMP_DIR

# Transfer to remote host.
echo "Transferring files to $REMOTE_HOST..."
ssh "$REMOTE_HOST" "rm -rf /tmp/inky-soup && mkdir -p /tmp/inky-soup"
scp -pr $DEPLOY_TEMP_DIR/* "$REMOTE_HOST:/tmp/inky-soup/"
echo "✓ Transfer complete"

# Copy to SD card (requires sudo for root-owned filesystem).
echo "Copying to SD card at $SDCARD_ROOT..."
ssh "$REMOTE_HOST" "sudo mkdir -p '$SDCARD_ROOT/home/pi/inky-soup'"
ssh "$REMOTE_HOST" "sudo cp -r /tmp/inky-soup/* '$SDCARD_ROOT/home/pi/inky-soup/'"
ssh "$REMOTE_HOST" "sudo chown -R 1000:1000 '$SDCARD_ROOT/home/pi/inky-soup/'"

# Optionally install the systemd service.
echo "Installing systemd service..."
ssh "$REMOTE_HOST" "sudo cp /tmp/inky-soup/inky-soup.service '$SDCARD_ROOT/etc/systemd/system/'"

echo ""
echo "✓ Deployment to SD card complete!"
echo ""
echo "Files installed to: $SDCARD_ROOT/home/pi/inky-soup/"
echo ""
echo "After booting the Pi:"
echo "  cd ~/inky-soup && ./upload-server"
echo ""
echo "Or enable the service:"
echo "  sudo systemctl daemon-reload"
echo "  sudo systemctl enable inky-soup.service"
echo "  sudo systemctl start inky-soup.service"
