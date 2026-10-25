"""Test the packaged Inky driver with simulated BUSY signals and no hardware.

Usage: python3 yocto/scripts/test_inky_refresh.py /path/to/inky_el133uf1.py
The source should come from the patched Yocto build or resulting rootfs.
"""

import importlib.util
import sys
import types
import unittest
import warnings
from enum import Enum
from unittest.mock import Mock, patch


class Value(Enum):
    INACTIVE = 0
    ACTIVE = 1


def load_driver(path):
    modules = {
        name: types.ModuleType(name)
        for name in ('inky', 'inky.eeprom', 'gpiod', 'gpiod.line', 'gpiodevice')
    }
    modules['gpiod.line'].Value = Value
    modules['gpiod.line'].Bias = Mock()
    modules['gpiod.line'].Direction = Mock()
    spec = importlib.util.spec_from_file_location('inky.inky_el133uf1', path)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, modules):
        spec.loader.exec_module(module)
    return module


class Clock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class RefreshTests(unittest.TestCase):
    def run_update(self, read_busy):
        clock = Clock()
        display = driver.Inky.__new__(driver.Inky)
        display.busy_pin = 17
        display.setup = Mock()
        display._busy_wait = Mock()
        display._gpio = Mock()
        display._gpio.get_value.side_effect = lambda pin: read_busy(clock.now)
        sent = []
        display._send_command = lambda command, *args: sent.append((command, clock.now))
        with patch.object(driver, 'time', clock), warnings.catch_warnings():
            warnings.simplefilter('error')
            try:
                display._update([0], [0])
            finally:
                self.sent = sent
        return clock.now

    def test_waits_until_busy_clears_before_power_off(self):
        duration = self.run_update(lambda t: Value.INACTIVE if t < 3 else Value.ACTIVE)
        self.assertGreaterEqual(duration, 3)
        self.assertEqual(self.sent[-1][0], driver.EL133UF1_POF)
        self.assertGreaterEqual(self.sent[-1][1], 3)

    def test_waits_for_delayed_busy_assertion(self):
        duration = self.run_update(lambda t: Value.INACTIVE if 0.1 <= t < 3 else Value.ACTIVE)
        self.assertGreaterEqual(duration, 3)

    def test_stuck_busy_fails_without_power_off(self):
        with self.assertRaisesRegex(UserWarning, 'Refresh Wait: Timed out'):
            self.run_update(lambda t: Value.INACTIVE)
        self.assertNotIn(driver.EL133UF1_POF, [command for command, _ in self.sent])

    def test_never_busy_fails_without_power_off(self):
        with self.assertRaisesRegex(UserWarning, 'waiting for busy'):
            self.run_update(lambda t: Value.ACTIVE)
        self.assertNotIn(driver.EL133UF1_POF, [command for command, _ in self.sent])


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: test_inky_refresh.py /path/to/inky_el133uf1.py")
    driver = load_driver(sys.argv[1])
    unittest.main(argv=[sys.argv[0]])
