"""Verify pre-dithered images reach the hardware buffer without recoloring."""

import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import warnings

import numpy
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("update_image", ROOT / "update-image.py")
UPDATE_IMAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPDATE_IMAGE)


def make_display(driver, width, height=1):
    """A buffer-only driver; set_image must never be called for prepared images."""
    display_class = type("Inky", (), {"__module__": f"inky.{driver}"})
    display = display_class()
    display.width = width
    display.height = height
    display.buf = numpy.full((height, width), 99, dtype=numpy.uint8)
    return display


class PreDitheredImageTests(unittest.TestCase):
    def test_spectra_six_native_codes_including_blue_and_green(self):
        colors = [
            (0, 0, 0), (255, 255, 255), (255, 255, 0),
            (255, 0, 0), (0, 0, 255), (0, 255, 0),
        ]
        for mode in ("RGB", "RGBA", "P"):
            with self.subTest(mode=mode):
                image = Image.new("RGB", (6, 1))
                image.putdata(colors)
                image = image.convert(mode)
                display = make_display("inky_el133uf1", 6)
                UPDATE_IMAGE.set_pre_dithered_image(display, image)
                self.assertEqual(display.buf.tolist(), [[0, 1, 2, 3, 5, 6]])

    def test_uc8159_preserves_orange_and_different_color_order(self):
        image = Image.new("RGB", (7, 1))
        image.putdata([
            (0, 0, 0), (255, 255, 255), (0, 255, 0), (0, 0, 255),
            (255, 0, 0), (255, 255, 0), (255, 140, 0),
        ])
        display = make_display("inky_uc8159", 7)
        UPDATE_IMAGE.set_pre_dithered_image(display, image)
        self.assertEqual(display.buf.tolist(), [[0, 1, 2, 3, 4, 5, 6]])

    def test_rejects_old_or_wrong_palette_without_changing_buffer(self):
        for color in [(255, 140, 0), (29, 24, 29), (156, 72, 75)]:
            with self.subTest(color=color):
                display = make_display("inky_el133uf1", 1)
                with self.assertRaisesRegex(ValueError, "regenerate the preview"):
                    UPDATE_IMAGE.set_pre_dithered_image(display, Image.new("RGB", (1, 1), color))
                self.assertEqual(display.buf.tolist(), [[99]])

    def test_rejects_transparency(self):
        with self.assertRaisesRegex(ValueError, "opaque"):
            UPDATE_IMAGE.set_pre_dithered_image(
                make_display("inky_el133uf1", 1), Image.new("RGBA", (1, 1), (0, 0, 0, 100))
            )

    def test_rejects_wrong_dimensions(self):
        with self.assertRaisesRegex(ValueError, "dimensions"):
            UPDATE_IMAGE.set_pre_dithered_image(
                make_display("inky_el133uf1", 2), Image.new("RGB", (1, 1))
            )

    def test_rejects_unsupported_driver(self):
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            UPDATE_IMAGE.set_pre_dithered_image(
                make_display("unknown", 1), Image.new("RGB", (1, 1))
            )

    def test_yocto_copy_is_identical(self):
        packaged = ROOT / "yocto/meta-inky-soup/recipes-inky-soup/inky-soup-display/files/update-image.py"
        self.assertEqual((ROOT / "update-image.py").read_bytes(), packaged.read_bytes())


class DisplayRefreshTests(unittest.TestCase):
    def run_flash(self, show):
        display = make_display("inky_el133uf1", 1)
        display.show = show
        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"
            Image.new("RGB", (1, 1)).save(image_path)
            with (
                patch.object(UPDATE_IMAGE, "get_display", return_value=display),
                patch.object(
                    UPDATE_IMAGE.sys, "argv",
                    ["update-image.py", str(image_path), "--skip-dither"],
                ),
            ):
                UPDATE_IMAGE.main()

    def test_driver_timeouts_fail_instead_of_reporting_completion(self):
        for message in [
            "Refresh Wait: Timed out waiting for busy after 65.00s",
            "Refresh Wait: Timed out after 65.00s",
            "Busy Wait: Timed out after 0.20s",
        ]:
            with self.subTest(message=message):
                with self.assertRaisesRegex(UserWarning, "Wait: Timed out"):
                    self.run_flash(lambda: warnings.warn(message, UserWarning))

    def test_successful_refresh_returns_normally(self):
        show = Mock()
        self.run_flash(show)
        show.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
