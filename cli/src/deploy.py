"""Install a staged application release on a Yocto frame; never touch photos."""

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
            display = get_json("/api/display-config")
            if "rotation_revision" not in display or "physical_width" not in display:
                raise RuntimeError("Server did not expose the orientation API")
            if not isinstance(get_json("/api/images"), list):
                raise RuntimeError("Server returned an invalid gallery")
            require_idle(get_json("/api/flash/status"))
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
            if not target.exists() or target.is_symlink():
                raise RuntimeError("Missing or linked installed asset: " + destination)
            previous = backup / name
            previous.parent.mkdir(parents=True, exist_ok=True)
            if target.is_dir():
                shutil.copytree(target, previous)
            else:
                shutil.copy2(target, previous)
            next_path = target.with_name(target.name + ".next-" + release)
            copy(bundle / name, next_path)
            staged.append(next_path)
        # Recheck immediately before the brief interruption, after staging copies.
        require_idle(status("/api/flash/status"))
        stopped = True
        command("systemctl", "stop", SERVICE)
        for name, destination in FILES.items():
            target = root / destination
            next_path = target.with_name(target.name + ".next-" + release)
            old_path = target.with_name(target.name + ".old-" + release)
            target.rename(old_path)
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
        if old_path.is_dir():
            shutil.rmtree(old_path)
        else:
            old_path.unlink()
    (backup / "deployed-revision.txt").write_text(revision + "\n")
    return {"ok": True, "revision": revision, "software_backup": str(backup), "display": display}
