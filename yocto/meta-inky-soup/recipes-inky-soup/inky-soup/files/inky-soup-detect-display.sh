#!/bin/sh
# Detect Inky Impression display type and write configuration.
# This runs at boot to auto-detect the connected display.

CONFIG_FILE="/etc/inky-soup/display.conf"

echo "Detecting Inky Impression display..."

# Try to detect display using Python inky library.
DISPLAY_INFO=$(python3 << 'EOF' 2>/dev/null
try:
    from inky.auto import auto
    display = auto()
    print(f"DISPLAY_WIDTH={display.width}")
    print(f"DISPLAY_HEIGHT={display.height}")
    print(f"DISPLAY_COLOR={display.colour}")

    # Calculate thumbnail dimensions (1/4 scale).
    thumb_width = display.width // 4
    thumb_height = display.height // 4
    print(f"THUMB_WIDTH={thumb_width}")
    print(f"THUMB_HEIGHT={thumb_height}")

    # Identify display model.
    if display.width == 600 and display.height == 448:
        print("DISPLAY_MODEL=impression-5.7")
    elif display.width == 1600 and display.height == 1200:
        print("DISPLAY_MODEL=impression-13.3")
    elif display.width == 800 and display.height == 480:
        print("DISPLAY_MODEL=impression-7.3")
    else:
        print(f"DISPLAY_MODEL=unknown-{display.width}x{display.height}")

except Exception as e:
    # Fallback to 5.7" Inky Impression defaults.
    print("# Auto-detection failed, using defaults")
    print("DISPLAY_WIDTH=600")
    print("DISPLAY_HEIGHT=448")
    print("DISPLAY_COLOR=multi")
    print("THUMB_WIDTH=150")
    print("THUMB_HEIGHT=112")
    print("DISPLAY_MODEL=impression-5.7-default")
EOF
)

if [ -n "$DISPLAY_INFO" ]; then
    echo "# Inky Soup display configuration." > "$CONFIG_FILE"
    echo "# Auto-generated at boot by inky-soup-detect-display." >> "$CONFIG_FILE"
    echo "# $(date)" >> "$CONFIG_FILE"
    echo "" >> "$CONFIG_FILE"
    echo "$DISPLAY_INFO" >> "$CONFIG_FILE"

    echo "Display configuration written to $CONFIG_FILE"
    cat "$CONFIG_FILE"
else
    echo "Warning: Could not detect display, using defaults."

    cat > "$CONFIG_FILE" << 'EOF'
# Inky Soup display configuration.
# Default configuration (5.7" Inky Impression).
DISPLAY_WIDTH=600
DISPLAY_HEIGHT=448
DISPLAY_COLOR=multi
THUMB_WIDTH=150
THUMB_HEIGHT=112
DISPLAY_MODEL=impression-5.7-default
EOF
fi

echo "Display detection complete."
