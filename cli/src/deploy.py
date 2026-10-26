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
import xml.etree.ElementTree as ET


FILES = {
    "server": "usr/bin/inky-soup-server",
    "discovery.service": "etc/avahi/services/inky-soup.service",
    "display": "usr/bin/inky-soup-update-display",
    "static/js": "usr/share/inky-soup/static/js",
    "static/chota.min.css": "usr/share/inky-soup/static/chota.min.css",
    "static/favicon.ico": "usr/share/inky-soup/static/favicon.ico",
    "templates": "usr/share/inky-soup/templates",
    "Rocket.toml": "usr/share/inky-soup/Rocket.toml",
}
SERVICE = "inky-soup-server.service"


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()


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
            identity = get_json("/api/device")
            if identity.get("api_version") != 1 or not identity.get("id") or not identity.get("instance_id"):
                raise RuntimeError("Server did not expose device identity")
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


def copy(source, target):
    if source.is_dir():
        shutil.copytree(source, target)
        for path in [target, *target.rglob("*")]:
            path.chmod(0o755 if path.is_dir() else 0o644)
    else:
        shutil.copyfile(source, target)
        target.chmod(0o755 if source.name in ("server", "display") else 0o644)


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
    # Validate the entire release before stopping a working server.
    for name in FILES:
        source = bundle / name
        if not source.exists() or source.is_symlink():
            raise RuntimeError("Missing or linked release asset: " + name)
        if source.is_dir() and any(path.is_symlink() for path in source.rglob("*")):
            raise RuntimeError("Linked release asset: " + name)
    if not (bundle / "server").read_bytes().startswith(b"\x7fELF"):
        raise RuntimeError("Server must be a target-native ELF executable")
    service = ET.parse(bundle / "discovery.service").getroot()
    if service.findtext("service/type") != "_inky-soup._tcp" or service.findtext("service/port") != "8000":
        raise RuntimeError("Discovery service must advertise _inky-soup._tcp on port 8000")
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
    stopped = False
    try:
        for name, destination in FILES.items():
            target = root / destination
            if (not target.exists() and name != "discovery.service") or target.is_symlink():
                raise RuntimeError("Missing or linked installed asset: " + destination)
            previous = backup / name
            previous.parent.mkdir(parents=True, exist_ok=True)
            if target.is_dir():
                shutil.copytree(target, previous)
            elif target.exists():
                shutil.copy2(target, previous)
            target.parent.mkdir(parents=True, exist_ok=True)
            next_path = target.with_name(target.name + ".next-" + release)
            staged.append(next_path)
            copy(bundle / name, next_path)
        # Recheck immediately before the brief interruption, after staging copies.
        require_idle(status("/api/flash/status"))
        stopped = True
        command("systemctl", "stop", SERVICE)
        for name, destination in FILES.items():
            target = root / destination
            next_path = target.with_name(target.name + ".next-" + release)
            old_path = target.with_name(target.name + ".old-" + release)
            if target.exists():
                target.rename(old_path)
            else:
                old_path = None
            replaced.append((target, old_path))
            next_path.rename(target)
        os.sync()
        command("systemctl", "start", SERVICE)
        display = health()
    except Exception as error:
        if stopped:
            command("systemctl", "stop", SERVICE)
            for target, old_path in reversed(replaced):
                if target.is_dir():
                    shutil.rmtree(target)
                elif target.exists():
                    target.unlink()
                if old_path is not None:
                    old_path.rename(target)
            command("systemctl", "start", SERVICE)
        recovery = "previous software restored" if stopped else "installed software unchanged"
        raise RuntimeError(f"Deployment failed; {recovery}: {error}") from error
    finally:
        for path in staged:
            if path.is_dir():
                shutil.rmtree(path)
            elif path.exists():
                path.unlink()
    for _, old_path in replaced:
        if old_path is None:
            continue
        if old_path.is_dir():
            shutil.rmtree(old_path)
        else:
            old_path.unlink()
    (backup / "deployed-revision.txt").write_text(revision + "\n")
    return {"ok": True, "revision": revision, "software_backup": str(backup), "display": display}
