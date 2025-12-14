#!/usr/bin/env python3

import sys
import time

from PIL import Image
from inky.inky_uc8159 import Inky

start_time = time.time()

print("Initializing display...", flush=True)
inky = Inky()
print(f"Display initialized in {time.time() - start_time:.1f}s", flush=True)

saturation = 0.5

if len(sys.argv) == 1:
    print("""
Usage: {file} image-file
""".format(file=sys.argv[0]))
    sys.exit(1)

load_start = time.time()
image = Image.open(sys.argv[1])

width, height = image.size
print(f"Image size: {width}x{height}", flush=True)

if width != 600 or height != 448:
    print("Resizing to 600x448...", flush=True)
    image = image.resize((600, 448), Image.BICUBIC)
    print(f"Resize complete in {time.time() - load_start:.1f}s", flush=True)
else:
    print("Image already 600x448, no resize needed.", flush=True)

if len(sys.argv) > 2:
    saturation = float(sys.argv[2])

print(f"Setting image with saturation={saturation}...", flush=True)
dither_start = time.time()
inky.set_image(image, saturation=saturation)
print(f"Dithering complete in {time.time() - dither_start:.1f}s", flush=True)

print("Sending to display...", flush=True)
show_start = time.time()
inky.show()
print(f"Display refresh complete in {time.time() - show_start:.1f}s", flush=True)

print(f"Total time: {time.time() - start_time:.1f}s", flush=True)
