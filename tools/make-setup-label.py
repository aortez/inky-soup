#!/usr/bin/env python3
"""Regenerate the printable setup label. Requires the Python qrcode package."""
from pathlib import Path
import qrcode

URL = "https://allan.pizza/setup/"
qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=4)
qr.add_data(URL)
qr.make(fit=True)
matrix = qr.get_matrix()
size = len(matrix)
path = " ".join(
    f"M{x} {y}h1v1h-1z"
    for y, row in enumerate(matrix)
    for x, dark in enumerate(row) if dark
)
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="70mm" height="85mm" viewBox="0 0 350 425" role="img" aria-labelledby="title desc">
<title id="title">Inky Soup WiFi setup label</title>
<desc id="desc">Scan the QR code or visit {URL} to set up WiFi using Chrome on Android or a supported computer.</desc>
<rect width="350" height="425" fill="white"/>
<g text-anchor="middle" font-family="sans-serif" fill="black">
<text x="175" y="42" font-size="23" font-weight="bold">INKY SOUP</text>
<text x="175" y="70" font-size="15">Scan to set up WiFi</text>
</g>
<svg x="40" y="82" width="270" height="270" viewBox="0 0 {size} {size}" shape-rendering="crispEdges"><path d="{path}" fill="black"/></svg>
<g text-anchor="middle" font-family="sans-serif" fill="black">
<text x="175" y="369" font-size="16">allan.pizza/setup/</text>
<text x="175" y="396" font-size="12">Use Chrome on Android or a computer</text>
</g>
</svg>
'''
output = Path(__file__).resolve().parents[1] / "docs/inky-soup-setup-label.svg"
output.write_text(svg)
print(output)
