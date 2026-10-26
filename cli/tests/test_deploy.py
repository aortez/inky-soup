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
        (self.bundle / "discovery.service").write_text('<service-group><service protocol="ipv4"><type>_inky-soup._tcp</type><port>8000</port></service></service-group>')
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
        if args[-1] == "--status":
            return json.dumps({"ok": True, "state": "idle", "wifi_connected": True})
        if args[:3] == ("systemctl", "show", deploy.PROVISIONER_SERVICE):
            if "InvocationID" in args:
                return "a" * 32
            return "path=/usr/bin/wifi-provisioner ;"
        if args[0] == "python3":
            return "--rotation"
        return "path=/usr/bin/inky-soup-server ;"

    def add_provisioner(self):
        (self.bundle / "provisioner").write_bytes(b"\x7fELFprovisioner")
        (self.bundle / "provisioner-revision.txt").write_text("shared-revision")
        (self.root / deploy.PROVISIONER_PATH).write_bytes(b"old provisioner")

    def test_optional_provisioner_installs_and_checks_health_before_starting_server(self):
        self.add_provisioner()
        result = self.apply()
        self.assertEqual(result["provisioner"]["revision"], "shared-revision")
        installed = self.root / deploy.PROVISIONER_PATH
        self.assertEqual(installed.read_bytes(), b"\x7fELFprovisioner")
        self.assertEqual(installed.stat().st_mode & 0o777, 0o755)
        backup = Path(result["software_backup"])
        self.assertEqual((backup / "provisioner").read_bytes(), b"old provisioner")
        self.assertEqual((backup / "deployed-provisioner-revision.txt").read_text(), "shared-revision\n")
        self.assertLess(self.commands.index((str(installed), "--status")),
                        self.commands.index(("systemctl", "start", deploy.SERVICE)))
        self.assert_preserved()

    def test_server_only_bundle_never_touches_provisioner(self):
        result = self.apply()
        self.assertNotIn("provisioner", result)
        self.assertFalse(any("provisioner" in " ".join(args) for args in self.commands))

    def test_provisioner_restart_failure_does_not_skip_server_recovery(self):
        self.add_provisioner()
        recovering = False
        active = {deploy.SERVICE: True, deploy.PROVISIONER_SERVICE: True}
        def command(*args):
            result = self.command(*args)
            if args[:2] == ("systemctl", "stop"):
                active[args[2]] = False
            if args[:2] == ("systemctl", "start"):
                if recovering and args[2] == deploy.PROVISIONER_SERVICE:
                    raise RuntimeError("injected provisioner restart failure")
                active[args[2]] = True
            return result
        def health():
            nonlocal recovering
            recovering = True
            raise RuntimeError("injected server health failure")
        with self.assertRaises(RuntimeError) as caught:
            self.apply(command=command, health=health)
        self.assertTrue(active[deploy.SERVICE])
        self.assertFalse(active[deploy.PROVISIONER_SERVICE])
        self.assertIn("injected server health failure", str(caught.exception))
        self.assertIn("injected provisioner restart failure", str(caught.exception))
        self.assertIn("recovery incomplete", str(caught.exception))
        self.assertEqual((self.root / "usr/bin/inky-soup-server").read_bytes(), b"old")
        self.assertEqual((self.root / deploy.PROVISIONER_PATH).read_bytes(), b"old provisioner")
        self.assert_preserved()

    def test_provisioner_failure_or_restart_during_server_health_rolls_back(self):
        self.add_provisioner()
        for failure in ("inactive", "status", "restarted"):
            with self.subTest(failure=failure):
                server_checked = False
                def health():
                    nonlocal server_checked
                    server_checked = True
                    return {"rotation_degrees": 180}
                def command(*args):
                    result = self.command(*args)
                    if server_checked:
                        if failure == "inactive" and args == ("systemctl", "is-active", deploy.PROVISIONER_SERVICE):
                            raise RuntimeError("provisioner inactive")
                        if failure == "status" and args == (str(self.root / deploy.PROVISIONER_PATH), "--status"):
                            raise RuntimeError("provisioner control failed")
                        if failure == "restarted" and "InvocationID" in args:
                            return "b" * 32
                    return result
                with self.assertRaisesRegex(RuntimeError, "previous software restored"):
                    self.apply(command=command, health=health)
                self.assertEqual((self.root / "usr/bin/inky-soup-server").read_bytes(), b"old")
                self.assertEqual((self.root / deploy.PROVISIONER_PATH).read_bytes(), b"old provisioner")
                self.assert_preserved()

    def test_provisioner_stop_failure_still_recovers_server_and_preserves_old_daemon(self):
        self.add_provisioner()
        recovering = False
        def command(*args):
            result = self.command(*args)
            if recovering and args == ("systemctl", "stop", deploy.PROVISIONER_SERVICE):
                raise RuntimeError("injected provisioner stop failure")
            return result
        def health():
            nonlocal recovering
            recovering = True
            raise RuntimeError("injected server health failure")
        with self.assertRaisesRegex(RuntimeError, "recovery incomplete.*provisioner stop failure"):
            self.apply(command=command, health=health)
        self.assertEqual((self.root / "usr/bin/inky-soup-server").read_bytes(), b"old")
        self.assertEqual(self.commands[-1], ("systemctl", "start", deploy.SERVICE))
        # Do not replace an executable whose service could not be stopped.
        self.assertEqual((self.root / deploy.PROVISIONER_PATH).read_bytes(), b"\x7fELFprovisioner")
        old = list((self.root / "usr/bin").glob("wifi-provisioner.old-*"))
        self.assertEqual(len(old), 1)
        self.assertEqual(old[0].read_bytes(), b"old provisioner")
        self.assert_preserved()

    def test_provisioner_file_restore_failure_does_not_skip_server_recovery(self):
        self.add_provisioner()
        rename = Path.rename
        def fail_restore(source, target):
            if source.name.startswith("wifi-provisioner.old-"):
                raise OSError("injected provisioner restore failure")
            return rename(source, target)
        def health():
            raise RuntimeError("injected server health failure")
        with patch.object(Path, "rename", new=fail_restore):
            with self.assertRaisesRegex(RuntimeError, "recovery incomplete.*provisioner restore failure"):
                self.apply(health=health)
        self.assertEqual((self.root / "usr/bin/inky-soup-server").read_bytes(), b"old")
        self.assertEqual(self.commands[-1], ("systemctl", "start", deploy.SERVICE))
        # No attempt to start the daemon with an incompletely restored binary.
        self.assertEqual(self.commands.count(("systemctl", "start", deploy.PROVISIONER_SERVICE)), 1)
        self.assertEqual(len(list((self.root / "usr/bin").glob("wifi-provisioner.old-*"))), 1)
        self.assert_preserved()

    def test_late_provisioner_failure_does_not_interrupt_new_display_jobs(self):
        self.add_provisioner()
        for job_state in ("Queued", "Flashing", "unavailable"):
            with self.subTest(job_state=job_state):
                self.commands.clear()
                server_checked = False
                def health():
                    nonlocal server_checked
                    server_checked = True
                    return {}
                def status(_):
                    if not server_checked:
                        return {"queue_length": 0, "queue": [], "current_job": None}
                    if job_state == "unavailable":
                        raise RuntimeError("display status unavailable")
                    return {"queue_length": 1 if job_state == "Queued" else 0,
                            "queue": [{"status": job_state}] if job_state == "Queued" else [],
                            "current_job": {"status": job_state}}
                def command(*args):
                    result = self.command(*args)
                    if server_checked and args == ("systemctl", "is-active", deploy.PROVISIONER_SERVICE):
                        raise RuntimeError("provisioner stopped unexpectedly")
                    return result
                with self.assertRaisesRegex(RuntimeError, "recovery incomplete.*Server left running"):
                    self.apply(command=command, health=health, status=status)
                self.assertEqual(self.commands.count(("systemctl", "stop", deploy.SERVICE)), 1)
                self.assertEqual((self.root / "usr/bin/inky-soup-server").read_bytes(), b"\x7fELFnew")
                self.assertEqual((self.root / deploy.PROVISIONER_PATH).read_bytes(), b"old provisioner")
                self.assertTrue(list((self.root / "usr/bin").glob("inky-soup-server.old-*")))
                self.assert_preserved()

    def test_final_health_result_is_fresh_and_restarts_during_status_are_rejected(self):
        self.add_provisioner()
        server_checked = False
        def health():
            nonlocal server_checked
            server_checked = True
            return {}
        def command(*args):
            if server_checked and args == (str(self.root / deploy.PROVISIONER_PATH), "--status"):
                return json.dumps({"ok": True, "state": "advertising", "wifi_connected": False})
            return self.command(*args)
        result = self.apply(command=command, health=health)
        self.assertEqual(result["provisioner"]["status"]["state"], "advertising")
        invocations = iter(["before", "after"])
        def restart(*args):
            if "InvocationID" in args:
                return next(invocations)
            return self.command(*args)
        with self.assertRaisesRegex(RuntimeError, "Provisioner restarted"):
            deploy.check_provisioner(restart, self.root / deploy.PROVISIONER_PATH, "before")

    def test_provisioner_or_server_health_failure_restores_both_binaries(self):
        self.add_provisioner()
        for failing in ("provisioner", "server"):
            with self.subTest(failing=failing):
                self.commands.clear()
                def unhealthy():
                    if failing == "server":
                        raise RuntimeError("server unavailable")
                    return {}
                def command(*args):
                    if args == (str(self.root / deploy.PROVISIONER_PATH), "--status") and failing == "provisioner":
                        raise RuntimeError("provisioner unavailable")
                    return self.command(*args)
                with patch.object(deploy.time, "monotonic", side_effect=[0, 31]):
                    with self.assertRaisesRegex(RuntimeError, "previous software restored"):
                        self.apply(command=command, health=unhealthy)
                self.assertEqual((self.root / deploy.PROVISIONER_PATH).read_bytes(), b"old provisioner")
                self.assertEqual((self.root / "usr/bin/inky-soup-server").read_bytes(), b"old")
                self.assertEqual(self.commands[-2:], [("systemctl", "start", deploy.PROVISIONER_SERVICE),
                                                     ("systemctl", "start", deploy.SERVICE)])
                self.assert_preserved()

    def test_active_setup_at_preflight_or_after_staging_prevents_installation(self):
        self.add_provisioner()
        for busy_check in (1, 2):
            for state in ("advertising", "connected", "provisioning"):
                with self.subTest(busy_check=busy_check, state=state):
                    self.commands.clear()
                    checks = 0
                    def command(*args):
                        nonlocal checks
                        if args[-1] == "--status":
                            checks += 1
                            if checks == busy_check:
                                return json.dumps({"ok": True, "state": state, "wifi_connected": True})
                        return self.command(*args)
                    with self.assertRaisesRegex(RuntimeError, "Wait for Bluetooth setup"):
                        self.apply(command=command)
                    self.assertFalse(any(args[:2] == ("systemctl", "stop") for args in self.commands))
                    self.assertEqual((self.root / deploy.PROVISIONER_PATH).read_bytes(), b"old provisioner")

    def test_invalid_optional_provisioner_never_stops_services(self):
        self.add_provisioner()
        (self.bundle / "provisioner").write_bytes(b"not executable")
        with self.assertRaisesRegex(RuntimeError, "target-native ELF"):
            self.apply()
        self.assertEqual(self.commands, [])
        (self.bundle / "provisioner").unlink()
        (self.bundle / "provisioner").symlink_to(self.root / deploy.PROVISIONER_PATH)
        with self.assertRaisesRegex(RuntimeError, "Missing or linked"):
            self.apply()
        self.assertEqual(self.commands, [])

    def test_provisioner_health_retries_startup_and_rejects_invalid_status(self):
        responses = iter(["not json", '{"ok":false}',
                          '{"ok":true,"state":"idle"}',
                          '{"ok":true,"state":"unknown","wifi_connected":true}',
                          '{"ok":true,"state":"idle","wifi_connected":true}'])
        def command(*args):
            return next(responses) if args[-1] == "--status" else "active"
        with patch.object(deploy.time, "sleep"):
            self.assertTrue(deploy.provisioner_health(command, Path("/usr/bin/wifi-provisioner"))["ok"])

    def test_failed_provisioner_replacement_restores_server_and_provisioner(self):
        self.add_provisioner()
        rename = Path.rename
        def fail_install(source, target):
            if source.name.startswith("wifi-provisioner.next-"):
                raise OSError("injected rename failure")
            return rename(source, target)
        with patch.object(Path, "rename", new=fail_install):
            with self.assertRaisesRegex(RuntimeError, "previous software restored"):
                self.apply()
        self.assertEqual((self.root / deploy.PROVISIONER_PATH).read_bytes(), b"old provisioner")
        self.assertEqual((self.root / "usr/bin/inky-soup-server").read_bytes(), b"old")
        self.assertEqual(list(self.root.rglob("*.next-*")), [])
        self.assert_preserved()

    def apply(self, **kwargs):
        return deploy.deploy(self.bundle, self.root, command=kwargs.get("command", self.command),
                             status=kwargs.get("status", lambda _: {"queue_length": 0, "queue": [], "current_job": None}),
                             health=kwargs.get("health", lambda: {"rotation_degrees": 180}))

    def test_discovery_is_added_to_an_older_installation(self):
        target = self.root / deploy.FILES["discovery.service"]
        target.unlink()
        self.apply()
        self.assertEqual(target.read_bytes(), (self.bundle / "discovery.service").read_bytes())
        self.assertEqual(self.photo.read_bytes(), b"original photo")

    def test_invalid_discovery_fails_before_stopping_service(self):
        (self.bundle / "discovery.service").write_text('<service-group><service><type>_other._tcp</type><port>80</port></service></service-group>')
        with self.assertRaisesRegex(RuntimeError, "Discovery service must advertise"):
            self.apply()
        self.assertNotIn(("systemctl", "stop", deploy.SERVICE), self.commands)

    def test_paired_deployment_rollback_removes_new_discovery_and_restores_both_services(self):
        self.add_provisioner()
        target = self.root / deploy.FILES["discovery.service"]
        target.unlink()
        def unhealthy():
            raise RuntimeError("server unavailable")
        with self.assertRaisesRegex(RuntimeError, "previous software restored"):
            self.apply(health=unhealthy)
        self.assertFalse(target.exists())
        self.assertEqual((self.root / "usr/bin/inky-soup-server").read_bytes(), b"old")
        self.assertEqual((self.root / deploy.PROVISIONER_PATH).read_bytes(), b"old provisioner")
        self.assertEqual(self.commands[-2:], [("systemctl", "start", deploy.PROVISIONER_SERVICE),
                                             ("systemctl", "start", deploy.SERVICE)])
        self.assert_preserved()

    def test_new_discovery_file_is_removed_on_rollback(self):
        target = self.root / deploy.FILES["discovery.service"]
        target.unlink()
        def fail():
            raise RuntimeError("failed health")
        with self.assertRaisesRegex(RuntimeError, "previous software restored"):
            self.apply(health=fail)
        self.assertFalse(target.exists())
        self.assertEqual((self.root / deploy.FILES["server"]).read_bytes(), b"old")

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
                    if path == "/api/device":
                        return {"api_version": 1, "id": "a" * 32, "instance_id": "b" * 32}
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
