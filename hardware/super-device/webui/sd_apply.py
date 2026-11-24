#!/usr/bin/env python3
"""On-device half of deploy.py. NOT installed on the Pi — deploy.py uploads it
next to the staged files each time and runs it as root in its own systemd unit.

Why it runs on the Pi: the install, the restart, the "does the daemon answer?"
check and the rollback must finish even if the SSH link drops halfway (at the
shop the only way in is a VPN over Wi-Fi). So the whole transaction lives here
and deploy.py only reads the result file afterwards.

    sd_apply.py apply --stage DIR     install DIR's files (manifest.json lists them)
    sd_apply.py rollback [--to ID]    put a saved set back (default: what the last deploy replaced)
    sd_apply.py status                installed hashes, daemon health, backups

apply:  verify the staged files (sha256 + compile + virtual-vehicle self-test)
        -> note whether the daemon is healthy NOW -> save the installed files as
        a backup -> swap the new ones in -> restart only the services whose file
        changed -> wait until the daemon answers AND reports the new file's hash
        -> if it does not: put the backup back, restart, check again.
Result: one JSON object, printed and written to /var/lib/superdevice/deploy/.
Pure standard library. It restarts superdevice-ui / superdevice-power only —
never a network service.
"""
import argparse
import hashlib
import json
import os
import py_compile
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

DEST = "/opt/superdevice"
BACKUPS = os.path.join(DEST, ".backups")
RESULTS = "/var/lib/superdevice/deploy"
BASE = "http://127.0.0.1:8080"
UI_UNIT = "superdevice-ui"
# file -> the service that must restart when it changes (None: nothing to restart;
# the virtual vehicle is a child the daemon starts on demand).
UNIT_FOR = {"superdevice_ui.py": UI_UNIT, "powerguard.py": "superdevice-power", "virtual_vehicle.py": None}
KEEP_BACKUPS = 6
HEALTH_WAIT = 35.0


def sha256(path):
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return ""


def run(cmd, timeout=60):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout + r.stderr).strip()
    except Exception as e:  # noqa: BLE001 — report, never raise out of a deploy step
        return 1, f"{type(e).__name__}: {e}"


def http_json(path, body=None, timeout=4.0):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or "{}")


def main_pid(unit):
    return run(["systemctl", "show", "-p", "MainPID", "--value", unit])[1].strip()


def health():
    """One look at the daemon. ok = the service is active and /api/status answers
    with its interface list. sha = the hash of the code it says it is running
    ("" on a daemon that predates /api/version)."""
    out = {"ok": False, "active": run(["systemctl", "is-active", UI_UNIT])[1], "pid": main_pid(UI_UNIT), "sha": "", "error": ""}
    try:
        st = http_json("/api/status")
        out["ok"] = out["active"] == "active" and isinstance(st.get("ifaces"), list)
        if not out["ok"]:
            out["error"] = f"service {out['active']}, status reply without ifaces"
    except Exception as e:  # noqa: BLE001
        out["error"] = f"{type(e).__name__}: {e}"
        return out
    try:
        out["sha"] = http_json("/api/version").get("daemon_sha256", "")
    except Exception:  # noqa: BLE001 — an older daemon has no /api/version
        pass
    return out


def wait_healthy(expect_sha, old_pid, restarted):
    """Poll until the daemon is healthy on two looks 2.5 s apart with the same pid
    (so a daemon that answers once and then crash-loops is not accepted). When the
    service was restarted it must also be the NEW code: its reported hash equals
    expect_sha, or — for a file that has no /api/version — at least a new pid."""
    deadline = time.time() + HEALTH_WAIT
    last = {"ok": False, "error": "not checked"}
    good = None
    while time.time() < deadline:
        h = health()
        last = h
        fresh = True
        if restarted:
            fresh = (h["sha"] == expect_sha) if h["sha"] else (h["pid"] not in ("", "0", old_pid))
            if h["ok"] and not fresh:
                h["error"] = "daemon answers but is not the new code (hash/pid unchanged)"
        if h["ok"] and fresh:
            if good and good["pid"] == h["pid"]:
                return True, h
            good = h
        else:
            good = None
        time.sleep(2.5 if good else 1.0)
    return False, last


def journal_tail(unit, n=25):
    return run(["journalctl", "-u", unit, "-n", str(n), "--no-pager", "-o", "cat"])[1][-3000:]


def install_file(src, name):
    """Swap one file in atomically, keeping the owner/mode of the one it replaces."""
    dst = os.path.join(DEST, name)
    tmp = os.path.join(DEST, f".{name}.new")
    shutil.copyfile(src, tmp)
    try:
        st = os.stat(dst)
        os.chown(tmp, st.st_uid, st.st_gid)
        os.chmod(tmp, st.st_mode & 0o7777)
    except OSError:
        os.chmod(tmp, 0o644)
    os.replace(tmp, dst)


def list_backups():
    """Every backup's meta, newest first (by the time it was taken, not by name)."""
    out = []
    try:
        names = os.listdir(BACKUPS)
    except OSError:
        names = []
    for n in names:
        try:
            meta = json.loads(open(os.path.join(BACKUPS, n, "meta.json")).read())
            out.append(meta)
        except Exception:  # noqa: BLE001
            continue
    out.sort(key=lambda m: m.get("created", ""), reverse=True)
    return out


def make_backup(bid, names, healthy, why, kind):
    d = os.path.join(BACKUPS, bid)
    os.makedirs(d, exist_ok=True)
    files = []
    for n in names:
        cur = os.path.join(DEST, n)
        existed = os.path.isfile(cur)
        if existed:
            shutil.copy2(cur, os.path.join(d, n))
        files.append({"name": n, "existed": existed, "sha256": sha256(cur) if existed else ""})
    meta = {"id": bid, "kind": kind, "created": time.strftime("%Y-%m-%dT%H:%M:%S"), "healthy": bool(healthy), "why": why, "files": files}
    with open(os.path.join(d, "meta.json"), "w") as f:
        f.write(json.dumps(meta, indent=1))
    return meta


def restore_backup(meta):
    d = os.path.join(BACKUPS, meta["id"])
    for f in meta["files"]:
        if f["existed"]:
            install_file(os.path.join(d, f["name"]), f["name"])
        else:
            try:
                os.remove(os.path.join(DEST, f["name"]))
            except OSError:
                pass


def prune_backups():
    metas = list_backups()
    keep = {m["id"] for m in metas[:KEEP_BACKUPS]}
    newest_good = next((m["id"] for m in metas if m.get("healthy")), None)
    if newest_good:
        keep.add(newest_good)
    for m in metas:
        if m["id"] not in keep:
            shutil.rmtree(os.path.join(BACKUPS, m["id"]), ignore_errors=True)


def units_for(names):
    return sorted({UNIT_FOR[n] for n in names if UNIT_FOR.get(n)})


def restart(units):
    notes = []
    for u in units:
        code, out = run(["systemctl", "restart", u], timeout=40)
        notes.append(f"restart {u}: {'ok' if code == 0 else out or code}")
    return notes


def sim_before():
    try:
        s = http_json("/api/sim/status")
        return s if s.get("running") else None
    except Exception:  # noqa: BLE001
        return None


def sim_restore(s):
    """A daemon restart ends the virtual vehicle it was running — start it again."""
    if not s:
        return None
    body = {"iface": s.get("iface") or "can1"}
    if s.get("replay"):
        body["replay"] = s["replay"]
    else:
        body["vehicle"] = s.get("vehicle") or "corolla"
    try:
        r = http_json("/api/sim/start", body, timeout=15)
        return f"virtual vehicle restarted ({body.get('replay') or body.get('vehicle')} on {body['iface']}): {'ok' if r.get('ok') else r.get('error')}"
    except Exception as e:  # noqa: BLE001
        return f"virtual vehicle NOT restarted: {e}"


def finish(result):
    result["finished"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    try:
        os.makedirs(RESULTS, exist_ok=True)
        text = json.dumps(result, indent=1)
        for name in (f"{result['id']}.json", "last.json"):
            with open(os.path.join(RESULTS, name), "w") as f:
                f.write(text)
        os.chmod(RESULTS, 0o755)
    except Exception as e:  # noqa: BLE001
        result["result_file_error"] = str(e)
    try:
        print(json.dumps(result))
    except Exception:  # noqa: BLE001 — stdout may be gone with the SSH session
        pass
    return 0 if result["status"] in ("deployed", "unchanged", "rolled_back_to") else 1


def do_rollback_to(meta, result, restarted_units):
    """Shared by a failed apply and the rollback command."""
    old_pid = main_pid(UI_UNIT)
    restore_backup(meta)
    result["steps"] += restart(restarted_units)
    restored_sha = next((f["sha256"] for f in meta["files"] if f["name"] == "superdevice_ui.py"), "") or sha256(os.path.join(DEST, "superdevice_ui.py"))
    ok, h = wait_healthy(restored_sha, old_pid, UI_UNIT in restarted_units)
    result["after_rollback"] = h
    return ok


def cmd_apply(stage):
    manifest = json.loads(open(os.path.join(stage, "manifest.json")).read())
    result = {"id": manifest["id"], "action": "apply", "status": "failed", "steps": [], "changed": [], "started": time.strftime("%Y-%m-%dT%H:%M:%S")}

    # 1 — the staged files are what the PC sent, and they are valid Python here
    for f in manifest["files"]:
        p = os.path.join(stage, f["name"])
        if f["name"] not in UNIT_FOR:
            result["error"] = f"{f['name']} is not a file this tool manages"
            return finish(result)
        if sha256(p) != f["sha256"]:
            result["error"] = f"{f['name']}: staged copy does not match what was sent (transfer damaged?)"
            return finish(result)
        try:
            with tempfile.NamedTemporaryFile(suffix=".pyc") as t:
                py_compile.compile(p, cfile=t.name, doraise=True)
        except Exception as e:  # noqa: BLE001
            result["error"] = f"{f['name']} does not compile on this Pi: {e}"
            return finish(result)
    vv = os.path.join(stage, "virtual_vehicle.py")
    if os.path.isfile(vv):
        code, out = run([sys.executable, vv, "--selftest"], timeout=90)
        if code != 0:
            result["error"] = "virtual_vehicle.py --selftest failed: " + out[-600:]
            return finish(result)
        result["steps"].append("virtual vehicle self-test passed")

    changed = [f["name"] for f in manifest["files"] if sha256(os.path.join(DEST, f["name"])) != f["sha256"]]
    result["changed"] = changed
    if not changed:
        result["status"] = "unchanged"
        result["health"] = health()
        return finish(result)

    # 2 — what "good" looks like before we touch anything
    before = health()
    sim = sim_before()
    result["before"] = before
    meta = make_backup(manifest["id"], changed, before["ok"], "before deploy " + manifest["id"], "deploy")
    result["backup"] = meta["id"]
    result["steps"].append(f"saved {len(changed)} installed file(s) as backup {meta['id']} (daemon was {'healthy' if before['ok'] else 'NOT healthy'})")

    # 3 — swap in, restart, check
    units = units_for(changed)
    try:
        for n in changed:
            install_file(os.path.join(stage, n), n)
        result["steps"].append("installed: " + ", ".join(changed))
        result["steps"] += restart(units)
        expect = next((f["sha256"] for f in manifest["files"] if f["name"] == "superdevice_ui.py"), "") or sha256(os.path.join(DEST, "superdevice_ui.py"))
        ok, h = wait_healthy(expect, before["pid"], UI_UNIT in units)
    except Exception as e:  # noqa: BLE001 — anything unexpected is a failed deploy
        ok, h = False, {"ok": False, "error": f"{type(e).__name__}: {e}"}
    result["health"] = h

    if ok:
        result["status"] = "deployed"
        if UI_UNIT in units:
            note = sim_restore(sim)
            if note:
                result["steps"].append(note)
        prune_backups()
        return finish(result)

    # 4 — it does not answer: put the last good files back
    result["steps"].append("daemon did not come back healthy: " + str(h.get("error") or h))
    result["journal"] = journal_tail(UI_UNIT)
    try:
        back = do_rollback_to(meta, result, units)
    except Exception as e:  # noqa: BLE001
        back = False
        result["after_rollback"] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    result["status"] = "rolled_back" if back else "rollback_failed"
    result["steps"].append("previous files restored and the daemon answers again" if back
                           else "ROLLBACK DID NOT RESTORE A HEALTHY DAEMON — fix by hand over SSH")
    if back and UI_UNIT in units:
        note = sim_restore(sim)
        if note:
            result["steps"].append(note)
    return finish(result)


def cmd_rollback(to, rid=None):
    rid = rid or "rb-" + time.strftime("%Y%m%d-%H%M%S")
    result = {"id": rid, "action": "rollback", "status": "failed", "steps": [], "started": time.strftime("%Y-%m-%dT%H:%M:%S")}
    metas = list_backups()
    # default: what the last deploy replaced, provided the daemon was healthy on it.
    # (A rollback's own undo-backup is reachable with --to, never picked by default.)
    meta = (next((m for m in metas if m["id"] == to), None) if to
            else next((m for m in metas if m.get("healthy") and m.get("kind") == "deploy"), None))
    if not meta:
        result["error"] = f"no backup '{to}'" if to else "no deploy backup that was healthy when it was taken"
        return finish(result)
    names = [f["name"] for f in meta["files"]]
    before = health()
    sim = sim_before()
    # the files being replaced become a backup themselves, so a rollback can be undone
    undo = make_backup(rid, names, before["ok"], f"before rollback to {meta['id']}", "rollback")
    result["backup"] = undo["id"]
    result["restored_from"] = meta["id"]
    units = units_for(names)
    ok = do_rollback_to(meta, result, units)
    result["health"] = result.pop("after_rollback")
    result["status"] = "rolled_back_to" if ok else "failed"
    if not ok:
        result["journal"] = journal_tail(UI_UNIT)
    elif UI_UNIT in units:
        note = sim_restore(sim)
        if note:
            result["steps"].append(note)
    return finish(result)


def cmd_status():
    print(json.dumps({
        "installed": {n: sha256(os.path.join(DEST, n)) for n in UNIT_FOR},
        "health": health(),
        "backups": [{"id": m["id"], "kind": m.get("kind"), "created": m["created"], "healthy": m.get("healthy"), "files": [f["name"] for f in m["files"]]} for m in list_backups()],
    }))
    return 0


def main():
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["apply", "rollback", "status"])
    ap.add_argument("--stage")
    ap.add_argument("--to")
    ap.add_argument("--id", help="rollback: the id to file the result under")
    a = ap.parse_args()
    if a.action == "status":
        return cmd_status()
    if os.geteuid() != 0:
        print(json.dumps({"status": "failed", "error": "must run as root"}))
        return 1
    if a.action == "apply":
        if not a.stage:
            ap.error("apply needs --stage DIR")
        return cmd_apply(a.stage)
    return cmd_rollback(a.to, a.id)


if __name__ == "__main__":
    sys.exit(main())
