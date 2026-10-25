"""Verify first-boot panel detection and configuration without GPIO hardware."""

import importlib.util
from pathlib import Path
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "yocto/meta-inky-soup/recipes-inky-soup/inky-soup-display/files/configure-display.py"
SPEC = importlib.util.spec_from_file_location("configure_display", SCRIPT)
CONFIGURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONFIGURE)


class DisplayConfigurationTests(unittest.TestCase):
    def detect(self, panel):
        eeprom = ModuleType("inky.eeprom")
        eeprom.read_eeprom = Mock(return_value=panel)
        with patch.dict("sys.modules", {"inky": ModuleType("inky"), "inky.eeprom": eeprom}):
            return CONFIGURE.detect_model()

    def test_detects_both_supported_panels(self):
        for width, height, variant, model in [
            (600, 448, 14, "impression-5.7"),
            (1600, 1200, 21, "impression-13.3-2025"),
        ]:
            with self.subTest(model=model):
                panel = SimpleNamespace(width=width, height=height, display_variant=variant)
                self.assertEqual(self.detect(panel), model)

    def test_does_not_guess_when_eeprom_is_missing_or_unsupported(self):
        for panel in [
            None,
            SimpleNamespace(width=640, height=400, display_variant=15),
            SimpleNamespace(width=600, height=448, display_variant=21),
        ]:
            with self.subTest(panel=panel), self.assertRaises(ValueError):
                self.detect(panel)

    def test_manual_setup_works_without_hardware_and_is_readable_by_server(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "inky-soup/display.conf"
            with patch.object(CONFIGURE, "detect_model", side_effect=AssertionError("No detection")):
                result = CONFIGURE.configure("impression-5.7", output)
            self.assertEqual(result["display"], {
                "width": 600, "height": 448, "thumb_width": 150, "thumb_height": 112,
                "model": "impression-5.7", "color": "multi",
            })
            self.assertIn("DISPLAY_MODEL=impression-5.7\n", output.read_text())
            self.assertIn("DISPLAY_WIDTH=600\nDISPLAY_HEIGHT=448\n", output.read_text())
            self.assertEqual(output.stat().st_mode & 0o777, 0o644)

    def test_failed_detection_or_write_preserves_existing_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "display.conf"
            output.write_text("existing settings\n")
            with patch.object(CONFIGURE, "detect_model", side_effect=ValueError("No EEPROM")):
                with self.assertRaises(ValueError):
                    CONFIGURE.configure("auto", output)
            with patch.object(CONFIGURE.os, "replace", side_effect=OSError("Read-only filesystem")):
                with self.assertRaises(OSError):
                    CONFIGURE.configure("impression-5.7", output)
            self.assertEqual(output.read_text(), "existing settings\n")
            self.assertEqual(list(output.parent.iterdir()), [output])

    def test_automatic_setup_writes_detected_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "display.conf"
            with patch.object(CONFIGURE, "detect_model", return_value="impression-13.3-2025"):
                result = CONFIGURE.configure("auto", output)
            self.assertEqual(result["display"]["width"], 1600)
            self.assertIn("DISPLAY_MODEL=impression-13.3-2025\n", output.read_text())
