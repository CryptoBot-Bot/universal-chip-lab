#!/usr/bin/env python3
"""Deploy the Super Device daemon to the Pi over SSH — by key, with a health
check and an automatic rollback.

    python deploy.py                  # deploy what changed, to the ssh host "superdevice"
    python deploy.py --status         # what differs + is the daemon healthy; changes nothing
    python deploy.py --dry-run        # show what a deploy would send; changes nothing
    python deploy.py --rollback       # put back what the last deploy replaced
    python deploy.py --rollback --to ID   # a specific backup (ids are listed by --status)
    python deploy.py --host superdevice-lan   # the same Pi over the home network
    python deploy.py --src DIR        # take the files from another directory
    python deploy.py --force          # deploy even while a PC holds the device's claim

Sign-in is the SSH key and host alias in ~/.ssh/config (Host superdevice — over
Tailscale, reachable from anywhere; superdevice-lan — at home). There is no
password path: this script only ever runs `ssh`/`scp` in batch mode.

What a deploy does:
  1. compiles every file here first, and refuses a file that names the VPN the Pi
     is reached through (see NEVER below);
  2. copies the changed files + sd_apply.py to a staging folder on the Pi (scp —
     pasting file bodies through an SSH shell corrupts them) and checks the hashes;
  3. runs sd_apply.py ON THE PI as its own systemd unit. It saves the installed
     files as a backup, swaps the new ones in, restarts only the affected service,
     and waits until the daemon answers AND reports the hash of the new file. If
     it does not, it puts the backup back and restarts again. Because that runs
     on the Pi, the rollback happens even if this PC loses the link mid-deploy;
  4. reads the result back, then checks the daemon from THIS PC over HTTP too —
     if it answered here before the deploy and does not now, that also rolls back.

Managed files: superdevice_ui.py, virtual_vehicle.py, powerguard.py.
NEVER deployed from here: ap.sh, netwatch.sh and the service units. They are the
Wi-Fi fallback, and together with the VPN daemon they are the only way into the
Pi while it is at the shop — change those by hand, on site, with a screen.

Exit code: 0 deployed / nothing to do / rolled back on request; 1 the deploy
failed and the previous files are back; 2 could not start or could not restore.
Requires: OpenSSH client (ssh, scp) on PATH. Pure standard library.
"""
import argparse
import hashlib
import json
import os
import py_compile
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANAGED = ["superdevice_ui.py", "virtual_vehicle.py", "powerguard.py"]
APPLY = "sd_apply.py"
REMOTE_DEST = "/opt/superdevice"
REMOTE_RESULTS = "/var/lib/superdevice/deploy"
FORBIDDEN = (b"tailscale",)   # the daemon has no business with the VPN it is reached through
SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=12"]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ssh(host: str, command: str, timeout: float = 60, check: bool = False) -> tuple[int, str]:
    try:
        r = subprocess.run(["ssh", *SSH_OPTS, host, command], capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return 124, "ssh timed out"
    except FileNotFoundError:
        raise SystemExit("ssh was not found on PATH (install the OpenSSH client).")
    out = (r.stdout + r.stderr).strip()
    if check and r.returncode != 0:
        raise SystemExit(f"ssh {host}: {out or 'failed'} (exit {r.returncode})")
    return r.returncode, out


def ssh_json(host: str, command: str, timeout: float = 60):
    code, out = ssh(host, command, timeout)
    if code != 0:
        return None
    try:
        return json.loads(out[out.index("{"):])
    except ValueError:
        return None


def http_address(host: str) -> str:
    """The Pi's address as the app reaches it: the HostName ssh resolves the alias to."""
    try:
        r = subprocess.run(["ssh", "-G", host], capture_output=True, text=True, timeout=10)
        for line in r.stdout.splitlines():
            if line.lower().startswith("hostname "):
                return line.split(None, 1)[1].strip()
    except Exception:  # noqa: BLE001
        pass
    return host


def http_json(addr: str, path: str, timeout: float = 5.0):
    with urllib.request.urlopen(f"http://{addr}:8080{path}", timeout=timeout) as r:
        return json.loads(r.read().decode() or "{}")


def pc_health(addr: str, tries: int = 1) -> dict:
    """Does the daemon answer from THIS PC (the path the app and the CLI use)?"""
    last = ""
    for i in range(tries):
        try:
            st = http_json(addr, "/api/status")
            if isinstance(st.get("ifaces"), list):
                sha = ""
                try:
                    sha = http_json(addr, "/api/version").get("daemon_sha256", "")
                except Exception:  # noqa: BLE001 — an older daemon has no /api/version
                    pass
                return {"ok": True, "sha": sha}
            last = "status reply without ifaces"
        except Exception as e:  # noqa: BLE001
            last = f"{type(e).__name__}: {e}"
        if i + 1 < tries:
            time.sleep(2)
    return {"ok": False, "error": last}


def local_files(src: Path) -> list[dict]:
    files = []
    for name in MANAGED:
        p = src / name
        if not p.is_file():
            print(f"  skip {name} (not in {src})")
            continue
        body = p.read_bytes()
        low = body.lower()
        for word in FORBIDDEN:
            if word in low:
                raise SystemExit(f"REFUSED: {name} mentions '{word.decode()}'. The daemon must never touch the VPN the Pi is "
                                 f"reached through — a mistake there cannot be fixed from here. Nothing was sent.")
        try:
            with tempfile.TemporaryDirectory() as t:
                py_compile.compile(str(p), cfile=str(Path(t) / "x.pyc"), doraise=True)
        except py_compile.PyCompileError as e:
            raise SystemExit(f"REFUSED: {name} does not compile:\n{e.msg}\nNothing was sent.")
        files.append({"name": name, "sha256": hashlib.sha256(body).hexdigest(), "path": p, "bytes": len(body)})
    if not files:
        raise SystemExit(f"No managed files found in {src}.")
    return files


def remote_status(host: str, stage_apply: bool = True) -> dict | None:
    """Installed hashes + daemon health + backups, straight from the Pi."""
    if stage_apply:
        ssh(host, "mkdir -p ~/.sd-deploy", check=True)
        scp(host, [HERE / APPLY], ".sd-deploy/")
    return ssh_json(host, "python3 ~/.sd-deploy/sd_apply.py status")


def scp(host: str, paths: list[Path], remote_dir: str) -> None:
    """Copy files to the Pi. They are gathered in a temp folder and sent by bare
    name from there: a Windows path with a drive letter reads to scp as a host name."""
    import shutil
    with tempfile.TemporaryDirectory() as t:
        for p in paths:
            shutil.copyfile(p, Path(t) / p.name)
        r = subprocess.run(["scp", "-q", *SSH_OPTS, *[p.name for p in paths], f"{host}:{remote_dir}"],
                           capture_output=True, text=True, timeout=180, cwd=t)
    if r.returncode != 0:
        raise SystemExit(f"scp to {host} failed: {(r.stdout + r.stderr).strip()}")


def show_result(res: dict) -> None:
    for s in res.get("steps", []):
        print(f"  · {s}")
    if res.get("error"):
        print(f"  ! {res['error']}")
    if res.get("journal"):
        print("  --- what the daemon logged when it failed to start ---")
        for line in res["journal"].splitlines()[-12:]:
            print(f"    {line}")


def run_on_pi(host: str, unit: str, args: str, result_id: str) -> dict | None:
    """Run sd_apply.py as a transient systemd unit and return its result. The unit
    keeps going if this SSH session dies, so afterwards the result FILE (named by
    result_id) is the truth — read it with retries rather than trusting the
    session's exit code."""
    cmd = f"sudo systemd-run --quiet --collect --wait --unit {unit} /usr/bin/python3 {args}"
    code, out = ssh(host, cmd, timeout=180)
    for attempt in range(12):
        res = ssh_json(host, f"cat {REMOTE_RESULTS}/{result_id}.json", timeout=30)
        if res and res.get("finished") and res.get("id") == result_id:
            return res
        # no result yet: the link dropped and the unit is still working, or it never started
        active = ssh(host, f"systemctl is-active {unit}", timeout=20)[1]
        if "active" != active.strip() and attempt >= 1:
            if code not in (0, 1):
                print(f"  ! could not run the on-device step: {out or 'ssh exit ' + str(code)}")
            return None
        time.sleep(5)
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Deploy the Super Device daemon (SSH key, health check, rollback).")
    ap.add_argument("--host", default=os.environ.get("SD_HOST", "superdevice"), help="ssh host alias from ~/.ssh/config (default: superdevice)")
    ap.add_argument("--src", default=str(HERE), help="directory holding the files to deploy (default: this one)")
    ap.add_argument("--status", action="store_true", help="compare local and installed files, show health and backups")
    ap.add_argument("--dry-run", action="store_true", help="show what would be sent; change nothing")
    ap.add_argument("--rollback", action="store_true", help="put back what the last deploy replaced")
    ap.add_argument("--to", help="with --rollback: the backup id to restore")
    ap.add_argument("--force", action="store_true", help="deploy even while a PC holds the device's occupancy claim")
    ap.add_argument("--all", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--password", help=argparse.SUPPRESS)
    args = ap.parse_args()

    if args.all or args.password or os.environ.get("SD_PASS"):
        print("Note: --all / --password / SD_PASS are gone. Sign-in is the SSH key in ~/.ssh/config, and the Wi-Fi helper "
              "scripts and service units are no longer deployable from here (see the header of this file).", file=sys.stderr)
        if args.all or args.password:
            return 2

    host = args.host
    code, who = ssh(host, "echo ok $(hostname)", timeout=25)
    if code != 0 or not who.startswith("ok"):
        print(f"Cannot reach '{host}' over SSH: {who or 'no answer'}\n"
              f"Check ~/.ssh/config has that Host and its key; at home try --host superdevice-lan.", file=sys.stderr)
        return 2
    addr = http_address(host)
    print(f"Pi: {who.split(None, 1)[1] if ' ' in who else host} via ssh '{host}' (http://{addr}:8080)")

    # ---- rollback on request -------------------------------------------------
    if args.rollback:
        if args.to and not all(c.isalnum() or c in "._-" for c in args.to):
            print("--to takes a backup id as printed by --status.", file=sys.stderr)
            return 2
        remote_status(host)  # stages sd_apply.py
        home = ssh(host, "cd ~/.sd-deploy && pwd", check=True)[1].splitlines()[-1]
        rid = "rb-" + time.strftime("%Y%m%d-%H%M%S")
        res = run_on_pi(host, f"sd-{rid}", f"{home}/sd_apply.py rollback --id {rid}" + (f" --to {args.to}" if args.to else ""), rid)
        if not res:
            print(f"No result came back from the Pi. Check: ssh {host} cat {REMOTE_RESULTS}/last.json", file=sys.stderr)
            return 2
        show_result(res)
        if res["status"] == "rolled_back_to":
            print(f"ROLLED BACK to backup {res.get('restored_from')} — the daemon answers. (Undo: --rollback --to {res.get('backup')})")
            return 0
        print(f"ROLLBACK FAILED ({res.get('status')}): {res.get('error') or res.get('health')}", file=sys.stderr)
        return 2

    files = local_files(Path(args.src).resolve())
    st = remote_status(host)
    if st is None:
        print("Could not read the Pi's state (is python3 there? is ~/.sd-deploy writable?).", file=sys.stderr)
        return 2
    installed = st.get("installed", {})
    changed = [f for f in files if installed.get(f["name"]) != f["sha256"]]

    print("Files:")
    for f in files:
        mark = "CHANGED" if f in changed else "same   "
        print(f"  {mark} {f['name']:22s} local {f['sha256'][:12]}  installed {(installed.get(f['name']) or 'absent')[:12]}")
    h = st.get("health", {})
    print(f"Daemon on the Pi: {'healthy' if h.get('ok') else 'NOT healthy — ' + str(h.get('error') or h.get('active'))}"
          + (f", running {h['sha'][:12]}" if h.get("sha") else ""))
    if h.get("sha") and h["sha"] != installed.get("superdevice_ui.py"):
        print("  ! the running daemon is not the installed file (edited after the last restart?) — a deploy will restart it")

    if args.status:
        backups = st.get("backups", [])
        print(f"Backups on the Pi ({len(backups)}):" if backups else "Backups on the Pi: none yet")
        for b in backups:
            print(f"  {b['id']:34s} {b.get('kind') or '?':8s} {b['created']}  {'healthy' if b.get('healthy') else 'taken while unhealthy'}  {', '.join(b['files'])}")
        pc = pc_health(addr)
        print(f"Daemon from this PC: {'answers' if pc['ok'] else 'NO ANSWER — ' + pc.get('error', '')}")
        return 0

    if not changed:
        print("Nothing to deploy — the Pi already has these files.")
        return 0
    if args.dry_run:
        print(f"Dry run: would send {', '.join(f['name'] for f in changed)} and restart what they belong to. Nothing changed.")
        return 0

    # ---- do not pull the daemon out from under someone ---------------------------
    try:
        claim = (http_json(addr, "/api/device", timeout=8) or {}).get("claim")
    except Exception:  # noqa: BLE001
        claim = None
    if claim and any(f["name"] == "superdevice_ui.py" for f in changed) and not args.force:
        mine = str(claim.get("owner", "")).lower() == socket.gethostname().lower()
        print(f"STOPPED: the device is claimed by {claim.get('owner')}{' (the app on this PC)' if mine else ''} — restarting the daemon "
              f"would cut a running scan or deep-map. Disconnect in the app, or pass --force.", file=sys.stderr)
        return 2

    before_pc = pc_health(addr)

    # ---- stage ----------------------------------------------------------------------
    did = time.strftime("%Y%m%d-%H%M%S") + "-" + changed[0]["sha256"][:6]
    stage_rel = f".sd-deploy/{did}"
    stage = ssh(host, f"mkdir -p ~/{stage_rel} && cd ~/{stage_rel} && pwd", check=True)[1].splitlines()[-1]
    with tempfile.TemporaryDirectory() as t:
        manifest = Path(t) / "manifest.json"
        manifest.write_text(json.dumps({"id": did, "from": socket.gethostname(), "files": [{"name": f["name"], "sha256": f["sha256"]} for f in changed]}), encoding="utf-8")
        scp(host, [f["path"] for f in changed] + [HERE / APPLY, manifest], stage_rel + "/")
    print(f"Staged {len(changed)} file(s) in {stage}; applying on the Pi (backup → install → restart → health check)…")

    # ---- apply (on the Pi, survives a dropped link) -------------------------------
    res = run_on_pi(host, f"sd-deploy-{did}", f"{stage}/sd_apply.py apply --stage {stage}", did)
    # keep the three newest staging folders
    ssh(host, "cd ~/.sd-deploy && ls -1d 20*/ 2>/dev/null | sort -r | tail -n +4 | xargs -r rm -rf", timeout=30)
    if not res:
        print(f"No result came back from the Pi (link lost?). The on-device step rolls itself back on failure; check with:\n"
              f"  python deploy.py --status        or        ssh {host} cat {REMOTE_RESULTS}/{did}.json", file=sys.stderr)
        return 2
    show_result(res)

    if res["status"] == "deployed":
        want = next((f["sha256"] for f in files if f["name"] == "superdevice_ui.py"), "")
        pc = pc_health(addr, tries=6)
        restarted = "superdevice_ui.py" in res.get("changed", [])   # only then must this PC see the new hash
        if pc["ok"] and (not restarted or not pc.get("sha") or pc["sha"] == want):
            print(f"DEPLOYED {', '.join(res['changed'])} — the daemon answers on the Pi and from this PC"
                  + (f", running {pc['sha'][:12]}" if pc.get("sha") else "") + f". Backup of the previous files: {res.get('backup')}")
            return 0
        if before_pc["ok"]:
            print(f"The daemon answers on the Pi but NOT from this PC ({pc.get('error') or 'wrong code hash'}), and it did before — rolling back.")
            rid = "rb-" + time.strftime("%Y%m%d-%H%M%S")
            rb = run_on_pi(host, f"sd-{rid}", f"{stage}/sd_apply.py rollback --id {rid} --to {res.get('backup')}", rid)
            if rb:
                show_result(rb)
            ok = bool(rb and rb.get("status") == "rolled_back_to")
            print("ROLLED BACK — the previous files are in place." if ok else "ROLLBACK FAILED — fix by hand over SSH.", file=sys.stderr)
            return 1 if ok else 2
        print(f"DEPLOYED on the Pi, but this PC cannot reach the daemon over HTTP ({pc.get('error')}) — it could not before either, so nothing was rolled back.")
        return 0
    if res["status"] == "unchanged":
        print("Nothing to deploy — the Pi already has these files.")
        return 0
    if res["status"] == "rolled_back":
        print("DEPLOY FAILED — the daemon did not come back healthy, so the previous files were put back and it answers again.", file=sys.stderr)
        return 1
    if res["status"] == "rollback_failed":
        print(f"DEPLOY FAILED AND THE ROLLBACK DID NOT RESTORE A HEALTHY DAEMON. SSH still works: ssh {host}\n"
              f"  backup of the previous files: {REMOTE_DEST}/.backups/{res.get('backup')}/", file=sys.stderr)
        return 2
    print(f"DEPLOY FAILED before anything was installed: {res.get('error')}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
