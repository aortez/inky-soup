#!/usr/bin/env python3
"""Build-time only: pip install Pillow==13.0.0 qrcode==8.2; no Pi dependency."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import qrcode

OUT = Path(__file__).resolve().parents[1] / 'upload-server' / 'rescue-cards'
URL = 'https://allan.pizza/setup/'


def render(width, height):
    image = Image.new('RGB', (width, height), 'white')
    draw = ImageDraw.Draw(image)
    scale = min(width / 448, height / 448)
    def text(y, value, size=17):
        font = ImageFont.truetype('DejaVuSans.ttf', round(size * scale))
        box = draw.textbbox((0, 0), value, font=font)
        draw.text(((width - box[2]) / 2, round(y * height) - box[1]), value,
                  fill='black', font=font)
    text(.045, 'Reconnect your frame', 25)
    text(.14, 'No local network connection', 17)
    text(.23, '1. Reconnect power to the frame.')
    text(.30, '2. Within 5 minutes, scan this code')
    text(.36, 'in Android Chrome. Turn Bluetooth on.')
    text(.43, '3. Connect to the frame and set Wi-Fi.')
    qr = qrcode.QRCode(box_size=1, border=4, error_correction=qrcode.constants.ERROR_CORRECT_M)
    qr.add_data(URL)
    qr.make(fit=True)
    code = qr.make_image().convert('RGB')
    multiple = max(1, int(height * .31 / code.width))
    code = code.resize((code.width * multiple, code.height * multiple), Image.Resampling.NEAREST)
    image.paste(code, ((width - code.width) // 2, int(height * .50)))
    text(.84, 'allan.pizza/setup/', 20)
    text(.93, 'Your photos are still saved on the frame.', 14)
    # Crisp, strictly native black/white pixels on either panel palette.
    return image.convert('L').point(lambda v: 255 if v >= 128 else 0).convert('RGB')


if __name__ == '__main__':
    OUT.mkdir(exist_ok=True)
    for w, h in [(600, 448), (448, 600), (1600, 1200), (1200, 1600)]:
        render(w, h).save(OUT / f'{w}x{h}.png', optimize=True)
