#!/usr/bin/env python3
"""Configure the app's physical display without refreshing the panel."""

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile


CONFIG_FILE = Path("/etc/inky-soup/display.conf")
PROFILES = {
    "impression-5.7": (600, 448, 14),
    "impression-13.3-2025": (1600, 1200, 21),
}


def detect_model():
    # Read only the identification EEPROM, without initializing SPI or GPIO.
    # Variant IDs match Pimoroni Inky 2.2.1's auto.py.
    from inky.eeprom import read_eeprom

    panel = read_eeprom()
    if panel is None:
        raise ValueError("No display EEPROM found; check the HAT or select --model explicitly")
    for model, (width, height, variant) in PROFILES.items():
        if (panel.width, panel.height, panel.display_variant) == (width, height, variant):
            return model
    raise ValueError(
        f"Unsupported display: variant {panel.display_variant}, {panel.width}x{panel.height}"
    )


def configure(model, output):
    if model == "auto":
        model = detect_model()
    width, height, _ = PROFILES[model]
    display = {
        "width": width,
        "height": height,
        "thumb_width": 150,
        "thumb_height": 112,
        "model": model,
        "color": "multi",
    }
    contents = (
        "# Physical panel configuration. Mount orientation is stored separately.\n"
        f"DISPLAY_MODEL={model}\nDISPLAY_WIDTH={width}\nDISPLAY_HEIGHT={height}\n"
        "THUMB_WIDTH=150\nTHUMB_HEIGHT=112\nDISPLAY_COLOR=multi\n"
    )
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=output.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(0o644)
        os.replace(temporary, output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return {"ok": True, "display": display, "path": str(output)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=["auto", *PROFILES], default="auto")
    parser.add_argument("--output", type=Path, default=CONFIG_FILE)
    args = parser.parse_args()
    try:
        print(json.dumps(configure(args.model, args.output)))
    except (OSError, ValueError, ImportError) as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
