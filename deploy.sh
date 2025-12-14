#!/bin/bash
#
# Builds and deploys the project to your Raspberry Pi Zero.
# Uses 'cross' for proper ARMv6 cross-compilation.

DEPLOY_TEMP_DIR=/tmp/inky-soup
BUILD_TYPE="${BUILD_TYPE:-release}"  # Can override with: BUILD_TYPE=debug ./deploy.sh
DEPLOY_USER="${DEPLOY_USER:-pi}"     # Can override with: DEPLOY_USER=oldman ./deploy.sh

set -euo pipefail

# Check prerequisites.
check_prerequisites() {
    echo "Checking prerequisites..."

    if [ -z "${INKY_SOUP_IP:-}" ]; then
        echo "ERROR: INKY_SOUP_IP environment variable not set."
        echo "Usage: INKY_SOUP_IP=<your-pi-ip-or-hostname> ./deploy.sh"
        echo "Example: INKY_SOUP_IP=inky-soup.local ./deploy.sh"
        exit 1
    fi

    # Check for cross (Docker-based cross-compilation).
    if ! command -v cross &> /dev/null && ! [ -x "$HOME/.cargo/bin/cross" ]; then
        echo "ERROR: 'cross' not found."
        echo "Run: ./setup-crosscompile.sh"
        exit 1
    fi

    # Check Docker is available.
    if ! docker info &> /dev/null; then
        echo "ERROR: Docker is not running or not accessible."
        echo "Run: ./setup-crosscompile.sh"
        exit 1
    fi

    echo "✓ Prerequisites OK"
}

check_prerequisites

# Use cross from cargo bin if not in PATH.
CROSS_CMD="cross"
if ! command -v cross &> /dev/null; then
    CROSS_CMD="$HOME/.cargo/bin/cross"
fi

# Directory for temp storage of deployment files.
echo "Preparing deployment directory..."
rm -rf $DEPLOY_TEMP_DIR
mkdir -p $DEPLOY_TEMP_DIR

# Stage service script.
cp inky-soup.service $DEPLOY_TEMP_DIR

# Build upload server using cross (proper ARMv6 support).
echo "Building upload server ($BUILD_TYPE mode) for ARM..."
cd upload-server
if [ "$BUILD_TYPE" = "release" ]; then
    $CROSS_CMD build --release --target=arm-unknown-linux-gnueabihf
    cp target/arm-unknown-linux-gnueabihf/release/upload-server $DEPLOY_TEMP_DIR
else
    $CROSS_CMD build --target=arm-unknown-linux-gnueabihf
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

# Deploy to your pi.
echo "Deploying to $DEPLOY_USER@$INKY_SOUP_IP..."
if scp -pr $DEPLOY_TEMP_DIR "$DEPLOY_USER@$INKY_SOUP_IP:~"; then
    echo "✓ Deployment successful!"
    echo ""
    echo "On your Pi, run:"
    echo "  cd ~/inky-soup"
    echo "  ./upload-server"
    echo ""
    echo "Or to install as a service:"
    echo "  sudo cp ~/inky-soup/inky-soup.service /etc/systemd/system/"
    echo "  sudo systemctl daemon-reload"
    echo "  sudo systemctl restart inky-soup.service"
else
    echo "ERROR: Deployment failed. Check network connection and SSH access."
    exit 1
fi
