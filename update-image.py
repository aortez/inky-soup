#!/usr/bin/env python3
"""
Flash an image to the Inky Impression e-ink display.

Reads display configuration from /etc/inky-soup/display.conf if available,
otherwise uses auto-detection or defaults to 13.3" Inky Impression 2025 (1600x1200).
"""

import argparse
import os
import sys
import time
import warnings

import numpy
from PIL import Image

# Configuration file path.
CONFIG_FILE = os.environ.get("INKY_SOUP_DISPLAY_CONFIG", "/etc/inky-soup/display.conf")

# Default dimensions (13.3" Inky Impression 2025).
DEFAULT_WIDTH = 1600
DEFAULT_HEIGHT = 1200


def read_display_config():
    """Read display configuration from config file."""
    config = {
        "width": DEFAULT_WIDTH,
        "height": DEFAULT_HEIGHT,
        "model": "impression-13.3-2025",
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
                    elif key == "DISPLAY_MODEL":
                        config["model"] = value
        except Exception as e:
            print(f"Warning: Could not read config file: {e}", flush=True)

    return config


def get_display():
    """Get the Inky display, using auto-detection if available."""
    try:
        # Try auto-detection first.
        from inky.auto import auto
        display = auto()
        if display is None:
            raise ValueError("No supported display EEPROM found")
        print(f"Auto-detected display: {display.width}x{display.height}", flush=True)
        return display
    except Exception as e:
        print(f"Auto-detection failed ({e}), falling back to manual init...", flush=True)

    # Respect the configured panel if its EEPROM cannot be read.
    try:
        model = read_display_config()["model"]
        if model == "impression-5.7":
            from inky.inky_uc8159 import Inky
            display = Inky(resolution=(600, 448))
        elif model == "impression-13.3-2025":
            from inky import InkyEL133UF1
            display = InkyEL133UF1()
        else:
            raise ValueError(f"Unsupported display model: {model}")
        print(f"Using {model}: {display.width}x{display.height}", flush=True)
        return display
    except Exception as e:
        print(f"Failed to initialize display: {e}", file=sys.stderr)
        sys.exit(1)


def set_pre_dithered_image(display, image):
    """Decode browser ink colors exactly, without another quantization pass."""
    if image.size != (display.width, display.height):
        raise ValueError("Pre-dithered image dimensions must match the display")

    driver = type(display).__module__.rsplit(".", 1)[-1]
    if driver == "inky_el133uf1":
        colors = [
            (0, 0, 0), (255, 255, 255), (255, 255, 0),
            (255, 0, 0), (0, 0, 255), (0, 255, 0),
        ]
        # EL133UF1's wire format skips code 4, unlike its Python color constants.
        codes = [0, 1, 2, 3, 5, 6]
    elif driver == "inky_uc8159":
        colors = [
            (0, 0, 0), (255, 255, 255), (0, 255, 0), (0, 0, 255),
            (255, 0, 0), (255, 255, 0), (255, 140, 0),
        ]
        codes = list(range(7))
    else:
        raise ValueError(f"Unsupported pre-dithered display driver: {driver}")

    rgba = numpy.asarray(image.convert("RGBA"))
    if numpy.any(rgba[:, :, 3] != 255):
        raise ValueError("Pre-dithered image must be opaque")

    rgb = rgba[:, :, :3]
    buffer = numpy.full((display.height, display.width), 255, dtype=numpy.uint8)
    for color, code in zip(colors, codes):
        buffer[numpy.all(rgb == color, axis=2)] = code

    if numpy.any(buffer == 255):
        raise ValueError(
            "Image contains colors outside the display palette; "
            "reload the web app and regenerate the preview"
        )

    # Both supported drivers consume native ink codes from this buffer in show().
    display.buf = buffer


def rotate_image(image, clockwise_degrees):
    """Turn whole pixels without resampling the encoded ink colors."""
    turns = {90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180,
             270: Image.Transpose.ROTATE_90}
    if clockwise_degrees == 0:
        return image
    if clockwise_degrees not in turns:
        raise ValueError("Rotation must be 0, 90, 180, or 270")
    return image.transpose(turns[clockwise_degrees])


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
    parser.add_argument("--rotation", type=int, choices=[0, 90, 180, 270], default=0,
                        help="Clockwise buffer rotation to compensate for mounting")
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
    image = rotate_image(Image.open(args.image), args.rotation)

    width, height = image.size
    print(f"Image size: {width}x{height}", flush=True)

    if width != target_width or height != target_height:
        if args.skip_dither:
            raise ValueError("Pre-dithered image dimensions must match the display")
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
        set_pre_dithered_image(inky, image)
    else:
        print(f"Dithering with saturation={args.saturation}...", flush=True)
        dither_start = time.time()
        inky.set_image(image, saturation=args.saturation)
        print(f"Dithering complete in {time.time() - dither_start:.1f}s", flush=True)

    print("Sending to display...", flush=True)
    show_start = time.time()
    # Driver timeouts must fail the job instead of reporting a successful flash.
    with warnings.catch_warnings():
        # UC8159 also warns when BUSY is already high and it deliberately waits
        # the full interval. That fallback is not a timeout failure.
        warnings.filterwarnings(
            "error", message=r"^(Busy|Refresh) Wait: Timed out", category=UserWarning
        )
        inky.show()
    print(f"Display refresh complete in {time.time() - show_start:.1f}s", flush=True)

    print(f"Total time: {time.time() - start_time:.1f}s", flush=True)


if __name__ == "__main__":
    main()
