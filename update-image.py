#!/usr/bin/env python3

import sys

from PIL import Image
from inky.inky_uc8159 import Inky

inky = Inky()
saturation = 0.5

if len(sys.argv) == 1:
    print("""
Usage: {file} image-file
""".format(file=sys.argv[0]))
    sys.exit(1)

image = Image.open(sys.argv[1])

width, height = image.size
print(f'image size: {width}x{height}')

if width != 600 or height != 448:
    print("resizing to 600x448")
    image = image.resize((600, 448), Image.BICUBIC)

if len(sys.argv) > 2:
    saturation = float(sys.argv[2])

inky.set_image(image, saturation=saturation)
inky.show()
