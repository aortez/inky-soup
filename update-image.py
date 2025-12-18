#!/usr/bin/env python3
"""
Flash an image to the Inky Impression e-ink display.

Reads display configuration from /etc/inky-soup/display.conf if available,
otherwise uses auto-detection or defaults to 5.7" Inky Impression (600x448).
"""

import argparse
import os
import sys
import time

from PIL import Image

# Configuration file path.
CONFIG_FILE = "/etc/inky-soup/display.conf"

# Default dimensions (5.7" Inky Impression).
DEFAULT_WIDTH = 600
DEFAULT_HEIGHT = 448


def read_display_config():
    """Read display configuration from config file."""
    config = {
        "width": DEFAULT_WIDTH,
        "height": DEFAULT_HEIGHT,
    }

    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("#") or "=" not in line:
                        continue
                    key, value = line.split("=", 1)
                    key = key.strip()
                    value = value.strip()

                    if key == "DISPLAY_WIDTH":
                        config["width"] = int(value)
                    elif key == "DISPLAY_HEIGHT":
                        config["height"] = int(value)
        except Exception as e:
            print(f"Warning: Could not read config file: {e}", flush=True)

    return config


def get_display():
    """Get the Inky display, using auto-detection if available."""
    try:
        # Try auto-detection first.
        from inky.auto import auto
        display = auto()
        print(f"Auto-detected display: {display.width}x{display.height}", flush=True)
        return display
    except Exception as e:
        print(f"Auto-detection failed ({e}), falling back to manual init...", flush=True)

    # Fall back to specific display type.
    try:
        from inky.inky_uc8159 import Inky
        return Inky()
    except Exception as e:
        print(f"Failed to initialize display: {e}", file=sys.stderr)
        sys.exit(1)


def main():
    start_time = time.time()

    # Parse command line arguments.
    parser = argparse.ArgumentParser(
        description="Flash an image to the Inky Impression display"
    )
    parser.add_argument("image", help="Path to image file")
    parser.add_argument(
        "saturation",
        nargs="?",
        type=float,
        default=0.5,
        help="Saturation level (0.0-1.0, default: 0.5)",
    )
    parser.add_argument(
        "--skip-dither",
        action="store_true",
        help="Skip dithering (image is pre-dithered)",
    )
    args = parser.parse_args()

    # Read display configuration.
    config = read_display_config()
    target_width = config["width"]
    target_height = config["height"]
    print(f"Target display size: {target_width}x{target_height}", flush=True)

    print("Initializing display...", flush=True)
    inky = get_display()
    print(f"Display initialized in {time.time() - start_time:.1f}s", flush=True)

    # Use display's actual dimensions if available.
    if hasattr(inky, "width") and hasattr(inky, "height"):
        target_width = inky.width
        target_height = inky.height
        print(f"Using display dimensions: {target_width}x{target_height}", flush=True)

    load_start = time.time()
    image = Image.open(args.image)

    width, height = image.size
    print(f"Image size: {width}x{height}", flush=True)

    if width != target_width or height != target_height:
        print(f"Resizing to {target_width}x{target_height}...", flush=True)
        image = image.resize((target_width, target_height), Image.Resampling.BICUBIC)
        print(f"Resize complete in {time.time() - load_start:.1f}s", flush=True)
    else:
        print(
            f"Image already {target_width}x{target_height}, no resize needed.",
            flush=True,
        )

    if args.skip_dither:
        print("Using pre-dithered image, sending directly to display...", flush=True)
        # Load pre-dithered palette image directly into buffer.
        # Convert to RGB first in case it's a palette image.
        if image.mode == "P":
            # Convert palette indices to RGB using the palette.
            rgb_image = image.convert("RGB")
            # Re-quantize to the Inky palette to get palette indices.
            inky.set_image(rgb_image, saturation=1.0)
        else:
            # If already RGB, convert to palette using Inky's palette.
            inky.set_image(image, saturation=1.0)
    else:
        print(f"Dithering with saturation={args.saturation}...", flush=True)
        dither_start = time.time()
        inky.set_image(image, saturation=args.saturation)
        print(f"Dithering complete in {time.time() - dither_start:.1f}s", flush=True)

    print("Sending to display...", flush=True)
    show_start = time.time()
    inky.show()
    print(f"Display refresh complete in {time.time() - show_start:.1f}s", flush=True)

    print(f"Total time: {time.time() - start_time:.1f}s", flush=True)


if __name__ == "__main__":
    main()
