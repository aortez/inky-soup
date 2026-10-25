import importlib.util
import errno
import json
from pathlib import Path
import subprocess
import sys
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
        return deploy.deploy(self.bundle, self.root, command=kwargs.get("command", self.command),
                             status=kwargs.get("status", lambda _: {"queue_length": 0, "queue": [], "current_job": None}),
                             health=kwargs.get("health", lambda: {"rotation_degrees": 180}))

    def competing_deployment(self):
        # Exercise a separate OS process, as with a second CLI or a retry after
        # losing SSH. Its service commands are simulated, never run on the host.
        script = """
import json, pathlib, runpy, sys
module = runpy.run_path(sys.argv[1])
module['os'].sync = lambda: None
root = pathlib.Path(sys.argv[3])
def command(*args):
    (root / 'competitor-command').write_text('called')
    return '--rotation' if args[0] == 'python3' else 'path=/usr/bin/inky-soup-server ;'
try:
    result = module['deploy'](sys.argv[2], root, command=command, health=lambda: {},
        status=lambda _: {'queue_length': 0, 'queue': [], 'current_job': None})
except Exception as error:
    result = {'ok': False, 'error': str(error)}
print(json.dumps(result))
"""
        result = subprocess.run(
            [sys.executable, "-c", script, str(Path(deploy.__file__)), str(self.bundle), str(self.root)],
            check=True, capture_output=True, text=True, timeout=10,
        )
        return json.loads(result.stdout)

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

    def test_jobs_accepted_after_restart_do_not_trigger_rollback(self):
        for job_status in ("Queued", "Flashing"):
            with self.subTest(job_status=job_status):
                self.commands.clear()
                display = {"rotation_revision": 0, "physical_width": 1600}
                def api(path):
                    if path == "/api/display-config":
                        return display
                    if path == "/api/images":
                        return []
                    return {"queue_length": 1 if job_status == "Queued" else 0,
                            "queue": [{"status": "Queued"}] if job_status == "Queued" else [],
                            "current_job": {"status": job_status}}
                with (patch.object(deploy, "get_json", side_effect=api),
                      patch.object(deploy.time, "monotonic", side_effect=[0, 46]),
                      patch.object(deploy.urllib.request, "urlopen")):
                    result = self.apply(health=deploy.health_check)
                self.assertTrue(result["ok"])
                self.assertEqual(result["display"], display)
                self.assertEqual(self.commands.count(("systemctl", "stop", deploy.SERVICE)), 1)
                self.assertEqual(self.commands.count(("systemctl", "start", deploy.SERVICE)), 1)
                self.assertEqual((self.root / "usr/bin/inky-soup-server").read_bytes(), b"\x7fELFnew")
                self.assert_preserved()

    def test_competing_process_is_excluded_through_preflight_staging_health_and_rollback(self):
        competitors = {}
        stops = 0
        original_copy = deploy.copy
        def command(*args):
            nonlocal stops
            if args[:2] == ("systemctl", "is-active"):
                competitors["preflight"] = self.competing_deployment()
            if args[:2] == ("systemctl", "stop"):
                stops += 1
                if stops == 2:
                    competitors["rollback"] = self.competing_deployment()
            return self.command(*args)
        def copy(source, target):
            if source == self.bundle / "server":
                competitors["staging"] = self.competing_deployment()
            original_copy(source, target)
        def unhealthy():
            competitors["health"] = self.competing_deployment()
            raise RuntimeError("new API unavailable")
        with patch.object(deploy, "copy", side_effect=copy):
            with self.assertRaisesRegex(RuntimeError, "previous software restored"):
                self.apply(command=command, health=unhealthy)
        self.assertEqual(set(competitors), {"preflight", "staging", "health", "rollback"})
        for phase, result in competitors.items():
            with self.subTest(phase=phase):
                self.assertFalse(result["ok"])
                self.assertIn("Another deployment is already running", result["error"])
        self.assertFalse((self.root / "competitor-command").exists())
        self.assertEqual((self.root / "usr/bin/inky-soup-server").read_bytes(), b"old")
        self.assert_preserved()
        # A failed operation releases the lock; a stale file must not block retry.
        self.assertTrue(self.competing_deployment()["ok"])

    def test_success_releases_lock_for_next_process(self):
        self.apply()
        self.assertTrue(self.competing_deployment()["ok"])

    def test_partial_file_and_directory_copies_are_removed_before_retry(self):
        for name, operation in (("server", "copyfile"), ("static/js", "copytree")):
            with self.subTest(asset=name):
                original_copy = getattr(deploy.shutil, operation)
                def fail_partway(source, target, *args, **kwargs):
                    if Path(source) == self.bundle / name:
                        target = Path(target)
                        if name == "static/js":
                            target.mkdir()
                            (target / "partial.js").write_bytes(b"partial")
                        else:
                            target.write_bytes(b"partial")
                        raise OSError(errno.ENOSPC, "No space left on device")
                    return original_copy(source, target, *args, **kwargs)
                with patch.object(deploy.shutil, operation, side_effect=fail_partway):
                    with self.assertRaisesRegex(RuntimeError, "installed software unchanged"):
                        self.apply()
                self.assertEqual(list(self.root.rglob("*.next-*")), [])
                self.assertNotIn(("systemctl", "stop", deploy.SERVICE), self.commands)
                self.assertEqual((self.root / "usr/bin/inky-soup-server").read_bytes(), b"old")
                self.assert_preserved()
        self.assertTrue(self.apply()["ok"])


if __name__ == "__main__":
    unittest.main()
