#!/bin/bash
#
# Sets up cross-compilation toolchain for Raspberry Pi Zero (ARM).
# This script is idempotent - safe to run multiple times.

set -e

echo "Setting up ARM cross-compilation environment..."

# Check if ARM target is already installed.
if rustup target list --installed | grep -q arm-unknown-linux-gnueabihf; then
    echo "✓ ARM target already installed"
else
    echo "Installing ARM target..."
    rustup target add arm-unknown-linux-gnueabihf
    echo "✓ ARM target installed"
fi

# Check if ARM GCC linker is installed.
if command -v arm-linux-gnueabihf-gcc &> /dev/null; then
    echo "✓ ARM GCC linker already installed"
else
    echo "Installing ARM GCC linker..."
    echo "This requires sudo and will install: gcc-arm-linux-gnueabihf"
    sudo apt-get update
    sudo apt-get install -y gcc-arm-linux-gnueabihf
    echo "✓ ARM GCC linker installed"
fi

# Create or update cargo config.
CARGO_CONFIG_DIR="$HOME/.cargo"
CARGO_CONFIG_FILE="$CARGO_CONFIG_DIR/config.toml"

mkdir -p "$CARGO_CONFIG_DIR"

# Check if config already has the ARM linker setting.
if [ -f "$CARGO_CONFIG_FILE" ] && grep -q "\[target.arm-unknown-linux-gnueabihf\]" "$CARGO_CONFIG_FILE"; then
    echo "✓ Cargo config already has ARM linker setting"
else
    echo "Configuring cargo linker for ARM..."
    cat >> "$CARGO_CONFIG_FILE" << 'EOF'

[target.arm-unknown-linux-gnueabihf]
linker = "arm-linux-gnueabihf-gcc"
EOF
    echo "✓ Cargo config updated"
fi

echo ""
echo "Cross-compilation setup complete!"
echo "You can now run: ./deploy.sh"
