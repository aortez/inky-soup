#!/usr/bin/env python3

import argparse
import sys
import time
import numpy

from PIL import Image
from inky.inky_uc8159 import Inky

start_time = time.time()

# Parse command line arguments.
parser = argparse.ArgumentParser(description='Flash an image to the Inky Impression display')
parser.add_argument('image', help='Path to image file')
parser.add_argument('saturation', nargs='?', type=float, default=0.5,
                    help='Saturation level (0.0-1.0, default: 0.5)')
parser.add_argument('--skip-dither', action='store_true',
                    help='Skip dithering (image is pre-dithered)')
args = parser.parse_args()

print("Initializing display...", flush=True)
inky = Inky()
print(f"Display initialized in {time.time() - start_time:.1f}s", flush=True)

load_start = time.time()
image = Image.open(args.image)

width, height = image.size
print(f"Image size: {width}x{height}", flush=True)

if width != 600 or height != 448:
    print("Resizing to 600x448...", flush=True)
    image = image.resize((600, 448), Image.Resampling.BICUBIC)
    print(f"Resize complete in {time.time() - load_start:.1f}s", flush=True)
else:
    print("Image already 600x448, no resize needed.", flush=True)

if args.skip_dither:
    print("Using pre-dithered image, sending directly to display...", flush=True)
    # Load pre-dithered palette image directly into buffer.
    # Convert to RGB first in case it's a palette image.
    if image.mode == "P":
        # Get the palette data.
        palette_data = image.getpalette()
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
