#!/bin/sh
# Detect Inky Impression display model and configure settings.
# Creates /etc/inky-soup/display.conf with appropriate environment variables.

CONFIG_DIR="/etc/inky-soup"
CONFIG_FILE="${CONFIG_DIR}/display.conf"

# Create config directory if needed.
mkdir -p "${CONFIG_DIR}"

# Read Pi model from device tree.
MODEL=$(cat /proc/device-tree/model 2>/dev/null | tr -d '\0')

case "${MODEL}" in
    *"Pi Zero W"*|*"Zero W"*)
        # Original Pi Zero W.
        cat > "${CONFIG_FILE}" << 'EOF'
# Pi Zero W.
PI_MODEL=zero_w
EOF
        echo "Configured for Pi Zero W"
        ;;
    *"Pi Zero 2"*|*"Zero 2"*)
        # Pi Zero 2 W.
        cat > "${CONFIG_FILE}" << 'EOF'
# Pi Zero 2 W.
PI_MODEL=zero_2_w
EOF
        echo "Configured for Pi Zero 2 W"
        ;;
    *)
        # Unknown model - use default.
        echo "Unknown model: ${MODEL} - using defaults"
        cat > "${CONFIG_FILE}" << 'EOF'
# Unknown model - using defaults.
PI_MODEL=unknown
EOF
        ;;
esac

chmod 644 "${CONFIG_FILE}"
