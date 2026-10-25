#!/usr/bin/env python3
"""Create an opaque 600x448 card using only the seven native Inky ink colors."""

import argparse
from PIL import Image, ImageDraw, ImageFont


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", help="Output PNG path")
    args = parser.parse_args()
    image = Image.new("RGB", (600, 448), "white")
    draw = ImageDraw.Draw(image)
    # Use a bitmap font so labels introduce no antialiased non-palette pixels.
    draw.fontmode = "1"
    font = ImageFont.load_default()
    draw.rectangle((0, 0, 599, 447), outline="black", width=3)
    draw.text((16, 14), "TOP - INKY IMPRESSION 5.7 - 600 x 448", fill="black", font=font)
    inks = [
        ("BLACK", (0, 0, 0), "white"),
        ("WHITE", (255, 255, 255), "black"),
        ("GREEN", (0, 255, 0), "black"),
        ("BLUE", (0, 0, 255), "white"),
        ("RED", (255, 0, 0), "black"),
        ("YELLOW", (255, 255, 0), "black"),
        ("ORANGE", (255, 140, 0), "black"),
    ]
    for index, (name, color, label) in enumerate(inks):
        top = 44 + index * 54
        draw.rectangle((12, top, 587, top + 49), fill=color, outline="black")
        draw.text((24, top + 18), name, fill=label, font=font)
    allowed = {color for _, color, _ in inks}
    colors = image.getcolors(maxcolors=8)
    assert colors is not None and {color for _, color in colors} <= allowed
    image.save(args.output, format="PNG")


if __name__ == "__main__":
    main()
