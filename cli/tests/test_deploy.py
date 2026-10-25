import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("deploy", Path(__file__).parents[1] / "src/deploy.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "device"
        self.bundle = Path(self.temp.name) / "bundle"
        self.commands = []
        for name, destination in deploy.FILES.items():
            source = self.bundle / name
            target = self.root / destination
            if name in ("static/js", "templates"):
                source /= "asset.txt"
                target /= "asset.txt"
            source.parent.mkdir(parents=True, exist_ok=True)
            target.parent.mkdir(parents=True, exist_ok=True)
            source.write_bytes(b"\x7fELFnew" if name == "server" else b"# new")
            target.write_bytes(b"old")
        (self.bundle / "revision.txt").write_text("test-revision")
        self.photo = self.root / "data/inky-soup/images/photo.png"
        self.photo.parent.mkdir(parents=True)
        self.photo.write_bytes(b"original photo")
        self.static_photo = self.root / "usr/share/inky-soup/static/images/old.png"
        self.static_photo.parent.mkdir(parents=True)
        self.static_photo.write_bytes(b"legacy photo")
        self.settings = self.root / "data/inky-soup/settings/display-runtime.json"
        self.settings.parent.mkdir(parents=True)
        self.settings.write_text('{"rotation_degrees":180}')
        self.sync = patch.object(deploy.os, "sync")
        self.sync.start()
        self.addCleanup(self.sync.stop)

    def command(self, *args):
        self.commands.append(args)
        if args[0] == "python3":
            return "--rotation"
        return "path=/usr/bin/inky-soup-server ;"

    def apply(self, **kwargs):
        return deploy.deploy(self.bundle, self.root, command=self.command,
                             status=kwargs.get("status", lambda _: {"queue_length": 0, "queue": [], "current_job": None}),
                             health=kwargs.get("health", lambda: {"rotation_degrees": 180}))

    def assert_preserved(self):
        self.assertEqual(self.photo.read_bytes(), b"original photo")
        self.assertEqual(self.static_photo.read_bytes(), b"legacy photo")
        self.assertEqual(self.settings.read_text(), '{"rotation_degrees":180}')

    def test_success_installs_pair_and_assets_without_touching_photo_storage(self):
        result = self.apply()
        self.assertTrue(result["ok"])
        self.assertEqual(result["revision"], "test-revision")
        for name, destination in deploy.FILES.items():
            relative = "/asset.txt" if name in ("static/js", "templates") else ""
            self.assertEqual((self.root / (destination + relative)).read_bytes(),
                             (self.bundle / (name + relative)).read_bytes())
            self.assertEqual((Path(result["software_backup"]) / (name + relative)).read_bytes(), b"old")
        self.assertEqual((self.root / "usr/bin/inky-soup-server").stat().st_mode & 0o777, 0o755)
        self.assert_preserved()

    def test_unhealthy_server_restores_entire_previous_release(self):
        def unhealthy():
            raise RuntimeError("new API unavailable")
        with self.assertRaisesRegex(RuntimeError, "previous software restored"):
            self.apply(health=unhealthy)
        for name, destination in deploy.FILES.items():
            relative = "/asset.txt" if name in ("static/js", "templates") else ""
            self.assertEqual((self.root / (destination + relative)).read_bytes(), b"old")
        self.assertEqual(self.commands[-1], ("systemctl", "start", deploy.SERVICE))
        self.assert_preserved()

    def test_incomplete_bundle_never_stops_service(self):
        (self.bundle / "display").unlink()
        with self.assertRaisesRegex(RuntimeError, "Missing or linked"):
            self.apply()
        self.assertEqual(self.commands, [])

    def test_job_arriving_during_staging_aborts_before_service_stop(self):
        replies = iter([{"queue_length": 0, "queue": [], "current_job": None},
                        {"queue_length": 0, "queue": [], "current_job": {"status": "Flashing"}}])
        with self.assertRaisesRegex(RuntimeError, "Wait for queued display jobs"):
            self.apply(status=lambda _: next(replies))
        self.assertNotIn(("systemctl", "stop", deploy.SERVICE), self.commands)
        self.assertEqual((self.root / "usr/bin/inky-soup-server").read_bytes(), b"old")
        self.assert_preserved()


if __name__ == "__main__":
    unittest.main()
