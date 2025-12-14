#!/bin/bash
#
# Sets up cross-compilation toolchain for Raspberry Pi Zero (ARMv6).
# Uses 'cross' (https://github.com/cross-rs/cross) which provides Docker-based
# cross-compilation with the correct stdlib for ARMv6.
#
# This script is idempotent - safe to run multiple times.

set -e

echo "Setting up ARM cross-compilation environment for Pi Zero..."

# Check if Docker is installed and running.
if ! command -v docker &> /dev/null; then
    echo "ERROR: Docker is required but not installed."
    echo "Please install Docker first: https://docs.docker.com/engine/install/"
    exit 1
fi

if ! docker info &> /dev/null; then
    echo "ERROR: Docker is installed but not running or you don't have permission."
    echo "Try: sudo systemctl start docker"
    echo "Or add yourself to the docker group: sudo usermod -aG docker \$USER"
    exit 1
fi
echo "✓ Docker is available"

# Check if cross is installed.
if command -v cross &> /dev/null || [ -x "$HOME/.cargo/bin/cross" ]; then
    echo "✓ cross is already installed"
else
    echo "Installing cross..."
    cargo install cross
    echo "✓ cross installed"
fi

# Check if ARM target is installed (cross needs this too).
if rustup target list --installed | grep -q arm-unknown-linux-gnueabihf; then
    echo "✓ ARM target already installed"
else
    echo "Installing ARM target..."
    rustup target add arm-unknown-linux-gnueabihf
    echo "✓ ARM target installed"
fi

echo ""
echo "Cross-compilation setup complete!"
echo ""
echo "To build for Pi Zero, use:"
echo "  cross build --release --target=arm-unknown-linux-gnueabihf"
echo ""
echo "Or run: ./deploy.sh"
