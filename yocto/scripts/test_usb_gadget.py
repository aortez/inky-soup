#!/usr/bin/env python3
"""Exercise the USB scripts with temporary hardware files and mocked commands."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


FILES = (
    Path(__file__).resolve().parents[1]
    / "meta-inky-soup/recipes-connectivity/inky-soup-usb-gadget/files"
)


class UsbGadgetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="inky-usb-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.net = self.root / "usb0"
        (self.net / "statistics").mkdir(parents=True)
        self.carrier = self.net / "carrier"
        self.carrier.write_text("1\n")
        self.rx = self.net / "statistics/rx_packets"
        self.rx.write_text("0\n")
        self.cpu = self.root / "cpuinfo"
        self.cpu.write_text("Serial\t\t: 00000000f41b6883\n")
        self.log = self.root / "commands"
        self.log.touch()
        self.env = {
            **os.environ,
            "PATH": f"{self.root}:{os.environ['PATH']}",
            "USB_TEST_LOG": str(self.log),
            "USB_TEST_RX": str(self.rx),
            "USB_TEST_ARP_EXIT": "1",
            "USB_TEST_RX_AFTER_PROBE": "",
        }
        # Replace only hardware paths; execute the production script logic.
        self.gadget = self.write_executable(
            "inky-soup-usb-gadget",
            (FILES / "inky-soup-usb-gadget").read_text().replace(
                "/proc/cpuinfo", str(self.cpu)
            ),
        )
        self.recover = self.write_executable(
            "inky-soup-usb-recover",
            (FILES / "inky-soup-usb-recover").read_text().replace(
                "/sys/class/net/usb0", str(self.net)
            ),
        )
        self.write_executable(
            "modprobe",
            '#!/bin/sh\nprintf "modprobe %s\\n" "$*" >> "$USB_TEST_LOG"\n',
        )
        self.write_executable(
            "arping",
            '#!/bin/sh\necho arping >> "$USB_TEST_LOG"\n'
            'if [ -n "$USB_TEST_RX_AFTER_PROBE" ]; then\n'
            '    printf "%s\\n" "$USB_TEST_RX_AFTER_PROBE" > "$USB_TEST_RX"\n'
            'fi\nexit "$USB_TEST_ARP_EXIT"\n',
        )

    def write_executable(self, name, content):
        path = self.root / name
        path.write_text(content)
        path.chmod(0o755)
        return path

    def run_recovery(self):
        subprocess.run(
            [str(self.recover)], env=self.env, check=True, capture_output=True
        )
        return self.log.read_text().splitlines()

    def assert_reloads_gadget(self):
        self.assertEqual(
            self.run_recovery(),
            [
                "arping",
                "modprobe -r g_ether",
                "modprobe dwc2",
                "modprobe g_ether dev_addr=02:00:f4:1b:68:83 "
                "host_addr=06:00:f4:1b:68:83",
            ],
        )

    def test_missing_interface_is_ignored(self):
        self.rx.unlink()
        self.assertEqual(self.run_recovery(), [])

    def test_disconnected_link_is_ignored(self):
        self.carrier.write_text("0\n")
        self.assertEqual(self.run_recovery(), [])

    def test_healthy_idle_host_is_not_reset(self):
        self.rx.write_text("23\n")
        self.env["USB_TEST_ARP_EXIT"] = "0"
        self.assertEqual(self.run_recovery(), ["arping"])

    def test_received_traffic_prevents_reset_even_if_arp_fails(self):
        self.rx.write_text("23\n")
        self.env["USB_TEST_RX_AFTER_PROBE"] = "24"
        self.assertEqual(self.run_recovery(), ["arping"])

    def test_zero_receive_startup_stall_is_recovered(self):
        self.assert_reloads_gadget()

    def test_stall_after_initial_packets_is_recovered(self):
        self.rx.write_text("3\n")
        self.assert_reloads_gadget()

    def test_missing_board_serial_does_not_load_modules(self):
        self.cpu.write_text("Serial\t\t: invalid\n")
        result = subprocess.run(
            [str(self.gadget)], env=self.env, capture_output=True, text=True
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.log.read_text(), "")


if __name__ == "__main__":
    unittest.main()
