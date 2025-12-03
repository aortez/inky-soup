#!/bin/bash
#
# Builds and deploys the project to your raspberry pi zero.

DEPLOY_TEMP_DIR=/tmp/inky-soup
BUILD_TYPE="${BUILD_TYPE:-release}"  # Can override with: BUILD_TYPE=debug ./deploy.sh

set -euo pipefail

# Check prerequisites.
check_prerequisites() {
    echo "Checking prerequisites..."

    if [ -z "${INKY_SOUP_IP:-}" ]; then
        echo "ERROR: INKY_SOUP_IP environment variable not set."
        echo "Usage: INKY_SOUP_IP=<your-pi-ip> ./deploy.sh"
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

    echo "✓ Prerequisites OK"
}

check_prerequisites

# Directory for temp storage of deployment files.
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

# Deploy to your pi.
echo "Deploying to pi@$INKY_SOUP_IP..."
if scp -pr $DEPLOY_TEMP_DIR pi@$INKY_SOUP_IP:~; then
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
