#!/usr/bin/env python3
"""
basefyio storage autopilot: keeps the Docker data volume from ever filling.

Runs once a minute from a systemd timer on the host. Each run:

  1. measures the data volume (the filesystem that holds Docker's data root)
     and the system disk;
  2. finishes a half-done resize: when the block device is larger than the
     filesystem on it, the filesystem is extended online;
  3. grows the Hetzner Cloud volume when usage crosses GROW_AT_PERCENT, when
     less than MIN_FREE_GB is left, or when the recent write rate would fill it
     within HORIZON_MINUTES, then extends the filesystem to match;
  4. frees reproducible space: recovery scratch left behind by a restore that
     is no longer running, and, when the volume is critically full, the build
     cache and oversized container logs. Volumes and backups are never touched;
  5. records every action as an event. The root console shows unacknowledged
     events as a red badge, and each one is mailed to ALERT_TO.

Growth is never silent. A Hetzner volume cannot shrink, so every growth is
money spent for good, and the operator has to see why it happened.

Configuration comes from the environment, then CONFIG_FILE, then ENV_FILE.
Both files are read line by line; neither is ever sourced.

  HCLOUD_TOKEN        Hetzner Cloud API token with read & write access. Without
                      it the autopilot still measures, extends and frees space,
                      and reports that automatic growth is off.
  CONFIG_FILE         default /etc/basefyio/storage-autopilot.env
  ENV_FILE            default /root/kolaybase/.env.production (mail settings)
  STATE_DIR           default /var/lib/basefyio-autopilot; platform-api mounts
                      it read-only to show status and events in the console
  DATA_MOUNT          default: the mount point that holds Docker's data root
  GROW_AT_PERCENT     default 80
  TARGET_PERCENT      usage a growth brings the volume back down to, default 65
  MIN_FREE_GB         default 100
  MIN_STEP_GB         default 50
  MAX_SIZE_GB         hard ceiling, default 2048 (Hetzner allows 10240)
  HORIZON_MINUTES     default 30
  RATE_GATE_PERCENT   the write rate only counts above this usage, default 70,
                      so a large but bounded job on a roomy volume never buys
                      space it does not need
  EMERGENCY_PERCENT   usage at which reproducible data is freed, default 95
  PITR_SCRATCH_VOLUME default kolaybase_pitr_scratch
  ALERT_TO            operator address for alert mail; unset = no mail
  DRY_RUN             "1" logs every decision without resizing or deleting

Install, as root:

  install -m 0755 scripts/storage-autopilot.py /usr/local/bin/basefyio-storage-autopilot
  install -m 0644 scripts/systemd/basefyio-storage-autopilot.service \\
                  scripts/systemd/basefyio-storage-autopilot.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now basefyio-storage-autopilot.timer
"""

import fcntl
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

GIB = 1024 ** 3
HCLOUD_API = "https://api.hetzner.cloud/v1"
TSMART_SEND_BASE_URL = "https://send.tsmart.ai"
RESEND_BASE_URL = "https://api.resend.com"

# Samples older than this are dropped; the longest rate window must fit inside.
SAMPLE_KEEP_SECONDS = 3600
RATE_WINDOWS_SECONDS = (120, 600, 1800)
# A run that has not refreshed its lease for this long is no longer running.
SCRATCH_LEASE_STALE_SECONDS = 30 * 60
# Scratch from before leases existed: idle this long with no container = dead.
SCRATCH_UNLEASED_STALE_SECONDS = 2 * 3600
# How often a still-true condition is reported again.
REPEAT_SECONDS = {
    "growth_unavailable": 6 * 3600,
    "growth_failed": 3600,
    "ceiling_reached": 6 * 3600,
    "system_disk_full": 6 * 3600,
}
GROW_RETRY_SECONDS = 10 * 60
TOKEN_CHECK_SECONDS = 6 * 3600
EVENTS_KEEP = 500


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def log(msg):
    print(f"{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')} {msg}", flush=True)


def read_env_file(path):
    """KEY=VALUE pairs, quotes stripped. Never sourced: values may hold < or &."""
    out = {}
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                out[key.strip()] = value
    except OSError:
        pass
    return out


class Config:
    def __init__(self):
        config_file = os.environ.get("CONFIG_FILE", "/etc/basefyio/storage-autopilot.env")
        env_file = os.environ.get("ENV_FILE", "/root/kolaybase/.env.production")
        self._sources = [os.environ, read_env_file(config_file), read_env_file(env_file)]

    def get(self, key, default=""):
        for source in self._sources:
            value = source.get(key)
            if value:
                return value
        return default

    def num(self, key, default):
        try:
            return float(self.get(key, str(default)))
        except ValueError:
            return float(default)


def run(cmd, timeout=120):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def fs_stats(path):
    """Totals as df reports them: used / (used + available)."""
    st = os.statvfs(path)
    total = st.f_blocks * st.f_frsize
    free = st.f_bfree * st.f_frsize
    avail = st.f_bavail * st.f_frsize
    used = total - free
    denominator = used + avail
    return {
        "totalBytes": total,
        "usedBytes": used,
        "availableBytes": avail,
        "usedPercent": round(used * 100 / denominator, 1) if denominator else 0.0,
    }


def docker_root_dir():
    try:
        out = run(["docker", "info", "--format", "{{.DockerRootDir}}"], timeout=30)
        return out.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def findmnt(target, field):
    out = run(["findmnt", "-no", field, "--target", target], timeout=15)
    return out.stdout.strip().splitlines()[0] if out.returncode == 0 and out.stdout.strip() else None


def block_device_bytes(device):
    name = os.path.basename(os.path.realpath(device))
    with open(f"/sys/class/block/{name}/size", encoding="ascii") as fh:
        return int(fh.read().strip()) * 512


def filesystem_bytes(device, mount, fstype):
    """The size the filesystem itself believes it has.

    statvfs() is no use here: ext4 leaves its own metadata out of f_blocks, so
    a fully extended 608 GB volume reports about 598 GB and would look
    permanently half-resized.
    """
    try:
        if fstype in ("ext4", "ext3", "ext2"):
            fields = {}
            for line in run(["tune2fs", "-l", device], timeout=30).stdout.splitlines():
                key, _, value = line.partition(":")
                fields[key.strip()] = value.strip()
            return int(fields["Block count"]) * int(fields["Block size"])
        if fstype == "xfs":
            out = run(["xfs_info", mount], timeout=30).stdout
            data = out[out.index("data "):].split("\n")[0]
            parts = dict(p.split("=") for p in data.replace(",", " ").split() if "=" in p)
            return int(parts["blocks"]) * int(parts["bsize"])
    except (KeyError, ValueError, OSError, subprocess.SubprocessError):
        pass
    return None


def hetzner_volume_id(device):
    """Hetzner exposes the volume id as the SCSI serial of its block device."""
    out = run(["lsblk", "-dno", "SERIAL", device], timeout=15)
    serial = out.stdout.strip()
    return serial if serial.isdigit() else None


def hcloud(token, method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        HCLOUD_API + path,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as err:
        try:
            payload = json.loads(err.read() or b"{}")
        except ValueError:
            payload = {}
        return err.code, payload


def hcloud_error(status, payload):
    error = (payload or {}).get("error") or {}
    return f"HTTP {status}: {error.get('message') or error.get('code') or 'no detail'}"


class Autopilot:
    def __init__(self, cfg):
        self.cfg = cfg
        self.dry_run = cfg.get("DRY_RUN") == "1"
        self.state_dir = cfg.get("STATE_DIR", "/var/lib/basefyio-autopilot")
        self.state_path = os.path.join(self.state_dir, "state.json")
        self.status_path = os.path.join(self.state_dir, "status.json")
        self.events_path = os.path.join(self.state_dir, "events.jsonl")
        self.state = self._load_state()
        self.token = cfg.get("HCLOUD_TOKEN")
        self.grow_at = cfg.num("GROW_AT_PERCENT", 80)
        self.target = cfg.num("TARGET_PERCENT", 65)
        self.min_free = cfg.num("MIN_FREE_GB", 100) * GIB
        self.min_step_gb = int(cfg.num("MIN_STEP_GB", 50))
        self.max_gb = int(cfg.num("MAX_SIZE_GB", 2048))
        self.horizon_min = cfg.num("HORIZON_MINUTES", 30)
        self.rate_gate = cfg.num("RATE_GATE_PERCENT", 70)
        self.emergency = cfg.num("EMERGENCY_PERCENT", 95)
        self.errors = []

    # ── State and events ────────────────────────────────────────────────────

    def _load_state(self):
        try:
            with open(self.state_path, encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return {}

    def _write_json(self, path, value):
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(value, fh, indent=2)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)

    def event(self, kind, severity, title, detail, metadata=None):
        entry = {
            "id": str(uuid.uuid4()),
            "at": now_iso(),
            "source": "storage-autopilot",
            "kind": kind,
            "severity": severity,
            "title": title,
            "detail": detail,
            "metadata": metadata or {},
        }
        log(f"EVENT {kind}: {title} — {detail}")
        try:
            lines = []
            if os.path.exists(self.events_path):
                with open(self.events_path, encoding="utf-8") as fh:
                    lines = fh.read().splitlines()
            lines.append(json.dumps(entry))
            tmp = self.events_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write("\n".join(lines[-EVENTS_KEEP:]) + "\n")
            os.chmod(tmp, 0o644)
            os.replace(tmp, self.events_path)
        except OSError as err:
            log(f"could not record event: {err}")
        self.mail(entry)

    def event_once(self, kind, severity, title, detail, metadata=None):
        """Report a condition that stays true at most once per its repeat window."""
        notified = self.state.setdefault("notified", {})
        last = notified.get(kind, 0)
        if time.time() - last < REPEAT_SECONDS.get(kind, 3600):
            return
        notified[kind] = time.time()
        self.event(kind, severity, title, detail, metadata)

    def clear_condition(self, kind):
        self.state.setdefault("notified", {}).pop(kind, None)

    def mail(self, entry):
        to = self.cfg.get("ALERT_TO")
        key = self.cfg.get("TSMART_SEND_API_KEY") or self.cfg.get("RESEND_API_KEY")
        sender = self.cfg.get("RESEND_FROM_EMAIL")
        if not to or not key or not sender:
            return
        base = self.cfg.get("RESEND_BASE_URL")
        if not base:
            tsmart = self.cfg.get("TSMART_SEND_API_KEY") or key.startswith("ts_")
            base = TSMART_SEND_BASE_URL if tsmart else RESEND_BASE_URL
        level = "CRITICAL" if entry["severity"] == "critical" else "Notice"
        html = (
            f"<p><strong>{entry['title']}</strong></p>"
            f"<p>{entry['detail']}</p>"
            "<p>Acknowledge it in the root console, where it stays as a red badge until you do.</p>"
            f"<p style='color:#888'>basefyio storage autopilot · {entry['at']}</p>"
        )
        body = json.dumps(
            {"from": sender, "to": [to], "subject": f"[basefyio] {level}: {entry['title']}", "html": html}
        ).encode()
        req = urllib.request.Request(
            base.rstrip("/") + "/emails",
            data=body,
            method="POST",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as res:
                log(f"alert mail sent ({res.status})")
        except (urllib.error.URLError, OSError) as err:
            log(f"alert mail failed: {err}")

    # ── Measurements ────────────────────────────────────────────────────────

    def data_mount(self):
        configured = self.cfg.get("DATA_MOUNT")
        if configured:
            return configured
        root = docker_root_dir()
        return findmnt(root, "TARGET") if root else None

    def write_rate(self, used):
        """Bytes per minute, the steepest of the recent windows; 0 when shrinking."""
        now = time.time()
        samples = [s for s in self.state.get("samples", []) if now - s[0] <= SAMPLE_KEEP_SECONDS]
        samples.append([now, used])
        self.state["samples"] = samples[-120:]
        rate = 0.0
        for window in RATE_WINDOWS_SECONDS:
            older = [s for s in samples if now - s[0] >= min(window, 50) and now - s[0] <= window + 60]
            if not older:
                continue
            ts, then_used = older[0]
            if now - ts > 0:
                rate = max(rate, (used - then_used) / (now - ts) * 60)
        return max(rate, 0.0)

    # ── Actions ─────────────────────────────────────────────────────────────

    def extend_filesystem(self, device, mount, fstype):
        if self.dry_run:
            log(f"DRY_RUN: would extend {fstype} on {device}")
            return True
        if fstype in ("ext4", "ext3", "ext2"):
            out = run(["resize2fs", device], timeout=600)
        elif fstype == "xfs":
            out = run(["xfs_growfs", mount], timeout=600)
        else:
            self.errors.append(f"cannot extend a {fstype} filesystem")
            return False
        if out.returncode != 0:
            self.errors.append(f"filesystem extend failed: {(out.stderr or out.stdout).strip()[-300:]}")
            return False
        return True

    def verify_token(self, volume_id):
        token_state = self.state.get("token", {})
        fresh = time.time() - token_state.get("checkedAt", 0) < TOKEN_CHECK_SECONDS
        if fresh and token_state.get("volumeId") == volume_id and token_state.get("hash") == hash_token(self.token):
            return token_state.get("ok", False), token_state.get("error")
        status, payload = hcloud(self.token, "GET", f"/volumes/{volume_id}")
        ok = status == 200
        error = None if ok else hcloud_error(status, payload)
        self.state["token"] = {
            "checkedAt": time.time(),
            "volumeId": volume_id,
            "hash": hash_token(self.token),
            "ok": ok,
            "error": error,
        }
        return ok, error

    def grow(self, device, volume_id, current_gb, new_gb):
        """Resize the Hetzner volume and wait until the kernel sees the new size."""
        if self.dry_run:
            log(f"DRY_RUN: would grow volume {volume_id} from {current_gb} GB to {new_gb} GB")
            return False, "dry run"
        status, payload = hcloud(self.token, "POST", f"/volumes/{volume_id}/actions/resize", {"size": new_gb})
        if status not in (200, 201):
            return False, hcloud_error(status, payload)
        action = (payload or {}).get("action") or {}
        deadline = time.time() + 300
        while action.get("status") == "running" and time.time() < deadline:
            time.sleep(3)
            status, payload = hcloud(self.token, "GET", f"/actions/{action.get('id')}")
            if status == 200:
                action = payload.get("action") or action
        if action.get("status") != "success":
            error = (action.get("error") or {}).get("message") or f"action {action.get('status')}"
            return False, f"Hetzner resize did not finish: {error}"

        name = os.path.basename(os.path.realpath(device))
        target = new_gb * GIB
        deadline = time.time() + 120
        while block_device_bytes(device) < target and time.time() < deadline:
            try:
                with open(f"/sys/class/block/{name}/device/rescan", "w", encoding="ascii") as fh:
                    fh.write("1")
            except OSError:
                pass
            time.sleep(3)
        if block_device_bytes(device) < target:
            return False, "the volume grew at Hetzner but the kernel still reports the old size"
        return True, None

    def sweep_scratch(self):
        """Delete recovery scratch whose restore is no longer running."""
        volume = self.cfg.get("PITR_SCRATCH_VOLUME", "kolaybase_pitr_scratch")
        out = run(["docker", "volume", "inspect", volume, "--format", "{{.Mountpoint}}"], timeout=30)
        root = out.stdout.strip()
        if out.returncode != 0 or not root or not os.path.isdir(root):
            return 0
        live = run(["docker", "ps", "--format", "{{.Names}}"], timeout=30).stdout.split()
        freed = 0
        for entry in os.listdir(root):
            if not entry.startswith("restore-"):
                continue
            path = os.path.join(root, entry)
            if not os.path.isdir(path):
                continue
            container = f"bf-pitr-{entry[len('restore-'):]}"
            lease = os.path.join(path, ".lease")
            if os.path.exists(lease):
                # The API refreshes the lease for as long as it owns the run, so a
                # quiet lease means the throwaway postgres is orphaned as well.
                if time.time() - os.path.getmtime(lease) < SCRATCH_LEASE_STALE_SECONDS:
                    continue
            else:
                if container in live:
                    continue
                newest = max(
                    [os.path.getmtime(path)]
                    + [os.path.getmtime(os.path.join(path, f)) for f in os.listdir(path)]
                )
                if time.time() - newest < SCRATCH_UNLEASED_STALE_SECONDS:
                    continue
            size = dir_bytes(path)
            if self.dry_run:
                log(f"DRY_RUN: would delete dead restore scratch {entry} ({size / GIB:.1f} GB)")
                continue
            if container in live:
                run(["docker", "rm", "-f", container], timeout=60)
            shutil.rmtree(path, ignore_errors=True)
            freed += size
            log(f"deleted dead restore scratch {entry} ({size / GIB:.1f} GB)")
        return freed

    def emergency_relief(self, docker_root):
        """Free reproducible data only. Volumes, WAL and backups are never touched."""
        if self.dry_run:
            log("DRY_RUN: would prune the build cache and truncate oversized container logs")
            return
        run(["docker", "builder", "prune", "-af"], timeout=600)
        containers = os.path.join(docker_root, "containers")
        for dirpath, _, files in os.walk(containers):
            for name in files:
                if name.endswith("-json.log"):
                    path = os.path.join(dirpath, name)
                    try:
                        if os.path.getsize(path) > 100 * 1024 * 1024:
                            os.truncate(path, 0)
                    except OSError:
                        pass

    # ── One pass ────────────────────────────────────────────────────────────

    def run_once(self):
        os.makedirs(self.state_dir, exist_ok=True)
        os.chmod(self.state_dir, 0o755)
        docker_root = docker_root_dir()
        mount = self.data_mount()
        if not mount:
            self.errors.append("could not find the data volume mount")
            self.write_status(None)
            return 1
        device = findmnt(mount, "SOURCE")
        fstype = findmnt(mount, "FSTYPE")
        volume_id = hetzner_volume_id(device) if device else None

        # 1. A resize that reached the block device but not the filesystem.
        fs = fs_stats(mount)
        block = block_device_bytes(device) if device else 0
        own_size = filesystem_bytes(device, mount, fstype) if device else None
        if block and own_size and block - own_size > 2 * GIB:
            before = fs["totalBytes"]
            if self.extend_filesystem(device, mount, fstype):
                fs = fs_stats(mount)
                if not self.dry_run and fs["totalBytes"] > before + GIB:
                    self.event(
                        "filesystem_extended",
                        "warning",
                        f"Data volume filesystem extended to {block / GIB:.0f} GB",
                        f"The volume was larger than the filesystem on it ({block / GIB:.0f} GB device, "
                        f"{own_size / GIB:.0f} GB filesystem), so the filesystem was extended online. "
                        f"Usage is now {fs['usedPercent']}%.",
                        {"fromBytes": own_size, "toBytes": block},
                    )

        # 2. Dead restore scratch is pure waste at any fill level.
        freed = self.sweep_scratch()
        if freed:
            fs = fs_stats(mount)
            self.event(
                "scratch_freed",
                "warning",
                f"Freed {freed / GIB:.1f} GB of dead restore scratch",
                "A point-in-time restore stopped without cleaning up after itself. Its working files "
                f"were deleted; the backups it was built from are untouched. Usage is now {fs['usedPercent']}%.",
                {"freedBytes": freed},
            )

        # 3. Grow before it fills.
        rate = self.write_rate(fs["usedBytes"])
        minutes_to_full = fs["availableBytes"] / rate if rate > 0 else None
        reasons = []
        if fs["usedPercent"] >= self.grow_at:
            reasons.append(f"usage reached {fs['usedPercent']}%")
        if fs["availableBytes"] < self.min_free:
            reasons.append(f"only {fs['availableBytes'] / GIB:.0f} GB free")
        if (
            minutes_to_full is not None
            and minutes_to_full < self.horizon_min
            and fs["usedPercent"] >= self.rate_gate
        ):
            reasons.append(
                f"writes of {rate / GIB:.1f} GB/min would fill it in {minutes_to_full:.0f} minutes"
            )

        current_gb = math.ceil(block / GIB) if block else math.ceil(fs["totalBytes"] / GIB)
        growth = {"configured": bool(self.token), "tokenOk": None, "error": None, "atCeiling": False}
        if self.token and volume_id:
            growth["tokenOk"], growth["error"] = self.verify_token(volume_id)
        elif self.token and not volume_id:
            growth["error"] = "the data volume is not a Hetzner Cloud volume"

        if reasons:
            self.try_grow(device, mount, fstype, volume_id, fs, rate, current_gb, reasons, growth)
            fs = fs_stats(mount)
        else:
            for kind in ("growth_unavailable", "growth_failed", "ceiling_reached"):
                self.clear_condition(kind)

        # 4. Critically full and still not grown: free what can be rebuilt.
        if fs["usedPercent"] >= self.emergency and docker_root:
            before = fs["usedBytes"]
            self.emergency_relief(docker_root)
            fs = fs_stats(mount)
            gained = before - fs["usedBytes"]
            if gained > GIB:
                self.event(
                    "emergency_relief",
                    "critical",
                    f"Emergency cleanup freed {gained / GIB:.1f} GB on the data volume",
                    f"The data volume reached {self.emergency:.0f}% and could not be grown in time, so "
                    f"the build cache and oversized container logs were cleared. Usage is now {fs['usedPercent']}%.",
                    {"freedBytes": gained},
                )

        # 5. The system disk cannot be grown from here; say so loudly.
        system = fs_stats("/")
        if system["usedPercent"] >= 90:
            self.event_once(
                "system_disk_full",
                "critical",
                f"System disk at {system['usedPercent']}%",
                "The server's own disk cannot be grown automatically. Free space on / or move "
                "the server to a larger type.",
            )
        else:
            self.clear_condition("system_disk_full")

        self.write_status(
            {
                "mount": mount,
                "device": device,
                "fstype": fstype,
                "volumeId": volume_id,
                "blockBytes": block_device_bytes(device) if device else None,
                **fs,
                "writeRateBytesPerMinute": round(rate),
                "minutesToFull": round(minutes_to_full) if minutes_to_full is not None else None,
                "system": system,
                "growth": growth,
            }
        )
        return 0

    def try_grow(self, device, mount, fstype, volume_id, fs, rate, current_gb, reasons, growth):
        why = "; ".join(reasons)
        if not self.token or not volume_id or growth.get("tokenOk") is False:
            problem = growth.get("error") or "no Hetzner Cloud API token is configured (HCLOUD_TOKEN)"
            self.event_once(
                "growth_unavailable",
                "critical",
                f"Data volume at {fs['usedPercent']}% and cannot grow automatically",
                f"It needs to grow because {why}, but {problem}. Grow it by hand in the Hetzner "
                "console before it fills.",
                {"usedPercent": fs["usedPercent"]},
            )
            return
        if current_gb >= self.max_gb:
            growth["atCeiling"] = True
            self.event_once(
                "ceiling_reached",
                "critical",
                f"Data volume at {fs['usedPercent']}% and already at its {self.max_gb} GB ceiling",
                f"It needs to grow because {why}, but MAX_SIZE_GB stops automatic growth here. "
                "Find what is filling it, or raise the ceiling.",
                {"usedPercent": fs["usedPercent"], "sizeGb": current_gb},
            )
            return
        if time.time() - self.state.get("lastGrowAttempt", 0) < GROW_RETRY_SECONDS:
            return

        used_gb = fs["usedBytes"] / GIB
        wanted = max(current_gb + self.min_step_gb, used_gb * 100 / self.target)
        if rate > 0:
            # Room for an hour of the current write rate on top of the target.
            wanted = max(wanted, (used_gb + rate * 60 / GIB) * 100 / self.target)
        new_gb = min(self.max_gb, int(math.ceil(wanted / 10.0) * 10))

        self.state["lastGrowAttempt"] = time.time()
        ok, error = self.grow(device, volume_id, current_gb, new_gb)
        if ok and not self.extend_filesystem(device, mount, fstype):
            ok, error = False, self.errors[-1] if self.errors else "filesystem extend failed"
        if not ok:
            if error == "dry run":
                return
            self.event_once(
                "growth_failed",
                "critical",
                f"Automatic growth of the data volume failed at {fs['usedPercent']}%",
                f"Tried to grow it from {current_gb} GB to {new_gb} GB because {why}, and it failed: "
                f"{error}. It is retried every {GROW_RETRY_SECONDS // 60} minutes.",
                {"fromGb": current_gb, "toGb": new_gb},
            )
            return

        after = fs_stats(mount)
        self.clear_condition("growth_failed")
        self.clear_condition("growth_unavailable")
        self.state["lastGrowAt"] = time.time()
        self.event(
            "volume_grown",
            "critical",
            f"Data volume grew automatically from {current_gb} GB to {new_gb} GB",
            f"It grew because {why}. Usage went from {fs['usedPercent']}% to {after['usedPercent']}% "
            f"({after['availableBytes'] / GIB:.0f} GB free). A Hetzner volume cannot shrink, so check "
            "what filled it.",
            {
                "fromGb": current_gb,
                "toGb": new_gb,
                "usedPercentBefore": fs["usedPercent"],
                "usedPercentAfter": after["usedPercent"],
                "writeRateBytesPerMinute": round(rate),
                "reasons": reasons,
            },
        )

    def write_status(self, data):
        status = {
            "checkedAt": now_iso(),
            "dryRun": self.dry_run,
            "thresholds": {
                "growAtPercent": self.grow_at,
                "targetPercent": self.target,
                "minFreeGb": self.min_free / GIB,
                "maxSizeGb": self.max_gb,
                "horizonMinutes": self.horizon_min,
                "emergencyPercent": self.emergency,
            },
            "lastGrowAt": (
                datetime.fromtimestamp(self.state["lastGrowAt"], timezone.utc).isoformat()
                if self.state.get("lastGrowAt")
                else None
            ),
            "errors": self.errors,
            "data": data,
        }
        try:
            self._write_json(self.status_path, status)
            self._write_json(self.state_path, self.state)
        except OSError as err:
            log(f"could not write status: {err}")


def hash_token(token):
    return hashlib.sha256((token or "").encode()).hexdigest()[:16]


def dir_bytes(path):
    total = 0
    for dirpath, _, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(dirpath, name)).st_size
            except OSError:
                pass
    return total


def main():
    cfg = Config()
    state_dir = cfg.get("STATE_DIR", "/var/lib/basefyio-autopilot")
    os.makedirs(state_dir, exist_ok=True)
    # One pass at a time: a resize can outlast the one-minute timer.
    lock = open(os.path.join(state_dir, ".lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log("previous pass still running")
        return 0
    pilot = Autopilot(cfg)
    try:
        return pilot.run_once()
    except Exception as err:  # the status file must still say something went wrong
        pilot.errors.append(f"{type(err).__name__}: {err}")
        pilot.write_status(None)
        raise


if __name__ == "__main__":
    sys.exit(main())
