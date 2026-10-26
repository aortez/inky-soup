"""Install a staged application release on a Yocto frame; never touch photos."""

import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request
import uuid


FILES = {
    "server": "usr/bin/inky-soup-server",
    "display": "usr/bin/inky-soup-update-display",
    "static/js": "usr/share/inky-soup/static/js",
    "static/chota.min.css": "usr/share/inky-soup/static/chota.min.css",
    "static/favicon.ico": "usr/share/inky-soup/static/favicon.ico",
    "templates": "usr/share/inky-soup/templates",
    "Rocket.toml": "usr/share/inky-soup/Rocket.toml",
}
SERVICE = "inky-soup-server.service"
PROVISIONER_SERVICE = "wifi-provisioner.service"
PROVISIONER_PATH = "usr/bin/wifi-provisioner"


def run(*args):
    timeout = 15 if args[-1:] == ("--status",) else None
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout).stdout.strip()


def get_json(path):
    with urllib.request.urlopen("http://127.0.0.1:8000" + path, timeout=3) as response:
        return json.load(response)


def require_idle(queue):
    if (queue.get("queue_length") != 0 or queue.get("queue") != []
            or (queue.get("current_job") is not None
                and queue["current_job"].get("status") not in ("Completed", "Failed"))):
        raise RuntimeError("Wait for queued display jobs before deploying")


def health_check():
    deadline = time.monotonic() + 45
    while True:
        try:
            display = get_json("/api/display-config")
            if "rotation_revision" not in display or "physical_width" not in display:
                raise RuntimeError("Server did not expose the orientation API")
            if not isinstance(get_json("/api/images"), list):
                raise RuntimeError("Server returned an invalid gallery")
            # The restarted server can already accept jobs. A busy display is
            # healthy and must not cause a rollback that interrupts its refresh.
            get_json("/api/flash/status")
            with urllib.request.urlopen("http://127.0.0.1:8000/", timeout=3) as response:
                response.read()
            return display
        except Exception:
            if time.monotonic() >= deadline:
                raise
            time.sleep(1)


def provisioner_status(command, executable):
    result = json.loads(command(str(executable), "--status"))
    if (result.get("ok") is not True
            or not isinstance(result.get("wifi_connected"), bool)
            or result.get("state") not in ("idle", "advertising", "connected", "provisioning")):
        raise RuntimeError("Provisioner returned an invalid status")
    return result


def require_setup_idle(command, executable):
    if provisioner_status(command, executable)["state"] != "idle":
        raise RuntimeError("Wait for Bluetooth setup to close before deploying its provisioner")


def provisioner_invocation(command):
    invocation = command("systemctl", "show", PROVISIONER_SERVICE, "-p", "InvocationID", "--value")
    if not invocation:
        raise RuntimeError("Provisioner has no active service invocation")
    return invocation


def check_provisioner(command, executable, invocation):
    command("systemctl", "is-active", PROVISIONER_SERVICE)
    if provisioner_invocation(command) != invocation:
        raise RuntimeError("Provisioner restarted during deployment")
    result = provisioner_status(command, executable)
    # The client can finish just as the daemon exits. Check both sides of IPC.
    command("systemctl", "is-active", PROVISIONER_SERVICE)
    if provisioner_invocation(command) != invocation:
        raise RuntimeError("Provisioner restarted during deployment")
    return result


def provisioner_health(command, executable, invocation=None):
    if invocation is None:
        invocation = provisioner_invocation(command)
    deadline = time.monotonic() + 30
    while True:
        try:
            return check_provisioner(command, executable, invocation)
        except Exception:
            if time.monotonic() >= deadline:
                raise
            time.sleep(1)


def rollback(stopped, replaced, command, root, keep_server=False):
    errors = []
    safe_to_restore = set()
    failed_assets = set()
    for service in stopped:
        if service == SERVICE and keep_server:
            errors.append("Server left running because the display queue is busy or unavailable")
            continue
        try:
            command("systemctl", "stop", service)
            safe_to_restore.add(service)
        except Exception as error:
            errors.append(f"Stop {service}: {error}")
    for target, old_path in reversed(replaced):
        service = PROVISIONER_SERVICE if target == root / PROVISIONER_PATH else SERVICE
        # Keep the old files for manual recovery if the owning service could not
        # be stopped. Never let one component's failure skip the other's recovery.
        if service not in safe_to_restore:
            continue
        try:
            if target.is_dir():
                shutil.rmtree(target)
            elif target.exists():
                target.unlink()
            old_path.rename(target)
        except Exception as error:
            failed_assets.add(service)
            errors.append(f"Restore {target}: {error}")
    for service in reversed(stopped):
        if service not in safe_to_restore or service in failed_assets:
            continue
        try:
            command("systemctl", "start", service)
        except Exception as error:
            errors.append(f"Start {service}: {error}")
    return errors


def copy(source, target):
    if source.is_dir():
        shutil.copytree(source, target)
        for path in [target, *target.rglob("*")]:
            path.chmod(0o755 if path.is_dir() else 0o644)
    else:
        shutil.copyfile(source, target)
        target.chmod(0o755 if source.name in ("server", "display", "provisioner") else 0o644)


def deploy(bundle, root=Path("/"), command=run, health=health_check, status=get_json):
    root = Path(root)
    lock_path = root / "run/lock/inky-soup-deploy.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    # Keep the same inode across invocations. Closing the descriptor releases
    # the kernel lock; unlinking the file would let contenders lock another inode.
    with lock_path.open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("Another deployment is already running; wait for it to finish before retrying") from error
        return _deploy_locked(bundle, root, command, health, status)


def _deploy_locked(bundle, root, command, health, status):
    bundle = Path(bundle)
    files = dict(FILES)
    has_provisioner = (bundle / "provisioner").exists() or (bundle / "provisioner").is_symlink()
    provisioner_revision = None
    if has_provisioner:
        files["provisioner"] = PROVISIONER_PATH
        provisioner_revision = (bundle / "provisioner-revision.txt").read_text().strip()
        if not provisioner_revision:
            raise RuntimeError("Missing provisioner source revision")
    # Validate the entire release before stopping a working server.
    for name in files:
        source = bundle / name
        if not source.exists() or source.is_symlink():
            raise RuntimeError("Missing or linked release asset: " + name)
        if source.is_dir() and any(path.is_symlink() for path in source.rglob("*")):
            raise RuntimeError("Linked release asset: " + name)
    if not (bundle / "server").read_bytes().startswith(b"\x7fELF"):
        raise RuntimeError("Server must be a target-native ELF executable")
    if has_provisioner:
        if not (bundle / "provisioner").read_bytes().startswith(b"\x7fELF"):
            raise RuntimeError("Provisioner must be a target-native ELF executable")
        command("systemctl", "is-active", PROVISIONER_SERVICE)
        execution = command("systemctl", "show", PROVISIONER_SERVICE, "-p", "ExecStart", "--value")
        if "path=/usr/bin/wifi-provisioner ;" not in execution:
            raise RuntimeError("Restore the normal provisioner service before deploying")
        # Running the staged client also checks its target ABI and shared libraries.
        require_setup_idle(command, bundle / "provisioner")
    compile((bundle / "display").read_text(), "display", "exec")
    if "--rotation" not in command("python3", str(bundle / "display"), "--help"):
        raise RuntimeError("Display script does not support orientation")
    revision = (bundle / "revision.txt").read_text().strip()
    command("systemctl", "is-active", SERVICE)
    execution = command("systemctl", "show", SERVICE, "-p", "ExecStart", "--value")
    if "path=/usr/bin/inky-soup-server ;" not in execution:
        raise RuntimeError("Stop the temporary preview before deploying")
    require_idle(status("/api/flash/status"))

    release = uuid.uuid4().hex
    backup = root / "var/lib/inky-soup/deployments" / release
    backup.mkdir(parents=True)
    staged = []
    replaced = []
    stopped = []
    provisioner = None
    server_healthy = False
    try:
        for name, destination in files.items():
            target = root / destination
            if not target.exists() or target.is_symlink():
                raise RuntimeError("Missing or linked installed asset: " + destination)
            previous = backup / name
            previous.parent.mkdir(parents=True, exist_ok=True)
            if target.is_dir():
                shutil.copytree(target, previous)
            else:
                shutil.copy2(target, previous)
            next_path = target.with_name(target.name + ".next-" + release)
            staged.append(next_path)
            copy(bundle / name, next_path)
        # Recheck immediately before the brief interruption, after staging copies.
        if has_provisioner:
            require_setup_idle(command, bundle / "provisioner")
        require_idle(status("/api/flash/status"))
        stopped.append(SERVICE)
        command("systemctl", "stop", SERVICE)
        if has_provisioner:
            stopped.append(PROVISIONER_SERVICE)
            command("systemctl", "stop", PROVISIONER_SERVICE)
        for name, destination in files.items():
            target = root / destination
            next_path = target.with_name(target.name + ".next-" + release)
            old_path = target.with_name(target.name + ".old-" + release)
            target.rename(old_path)
            replaced.append((target, old_path))
            next_path.rename(target)
        os.sync()
        if has_provisioner:
            command("systemctl", "start", PROVISIONER_SERVICE)
            invocation = provisioner_invocation(command)
            provisioner_health(command, root / PROVISIONER_PATH, invocation)
        command("systemctl", "start", SERVICE)
        display = health()
        server_healthy = True
        if has_provisioner:
            provisioner = check_provisioner(command, root / PROVISIONER_PATH, invocation)
    except Exception as error:
        recovery_errors = []
        if stopped:
            keep_server = False
            if server_healthy:
                try:
                    require_idle(status("/api/flash/status"))
                except Exception:
                    # A late provisioner failure must not interrupt a refresh
                    # accepted by the healthy server after its restart.
                    keep_server = True
            recovery_errors = rollback(stopped, replaced, command, root, keep_server)
        if recovery_errors:
            details = "; ".join(recovery_errors)
            raise RuntimeError(f"Deployment failed: {error}; recovery incomplete: {details}; "
                               f"software backup: {backup}") from error
        recovery = "previous software restored" if stopped else "installed software unchanged"
        raise RuntimeError(f"Deployment failed; {recovery}: {error}") from error
    finally:
        for path in staged:
            if path.is_dir():
                shutil.rmtree(path)
            elif path.exists():
                path.unlink()
    for _, old_path in replaced:
        if old_path.is_dir():
            shutil.rmtree(old_path)
        else:
            old_path.unlink()
    (backup / "deployed-revision.txt").write_text(revision + "\n")
    result = {"ok": True, "revision": revision, "software_backup": str(backup), "display": display}
    if has_provisioner:
        (backup / "deployed-provisioner-revision.txt").write_text(provisioner_revision + "\n")
        result["provisioner"] = {"revision": provisioner_revision, "status": provisioner}
    return result
