#!/usr/bin/env python3
"""Deploy the Super Device web UI to the Pi over SSH/SFTP and restart it.

Uploads superdevice_ui.py (and, with --all, the ap/netwatch helpers) to
/opt/superdevice/ and restarts the systemd service. Big-paste-over-SSH corrupts,
so we always transfer files via SFTP.

Usage:
    python deploy.py                       # host=superdevice.local, pw from $SD_PASS
    python deploy.py --host 192.168.1.67   # explicit IP if mDNS isn't resolving
    python deploy.py --all                 # also push ap.sh / netwatch / service units
    SD_PASS='Welcome1!' python deploy.py

Requires: paramiko (pip install paramiko).
"""
import argparse
import os
import sys
from pathlib import Path

import paramiko

HERE = Path(__file__).resolve().parent
REMOTE_DIR = "/opt/superdevice"
CORE = ["superdevice_ui.py", "powerguard.py"]
EXTRA = ["ap.sh", "netwatch.sh", "superdevice-netwatch.service", "superdevice-ui.service", "superdevice-power.service"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=os.environ.get("SD_HOST", "superdevice.local"))
    ap.add_argument("--user", default=os.environ.get("SD_USER", "cryptobot"))
    ap.add_argument("--password", default=os.environ.get("SD_PASS", ""))
    ap.add_argument("--all", action="store_true", help="also push ap/netwatch/service files")
    args = ap.parse_args()

    if not args.password:
        print("No password. Pass --password or set SD_PASS.", file=sys.stderr)
        return 2

    files = CORE + (EXTRA if args.all else [])

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        cli.connect(args.host, username=args.user, password=args.password, timeout=8)
    except Exception as e:
        print(f"Could not reach {args.host}: {e}", file=sys.stderr)
        print("Is the Pi on this network? Try --host with its IP.", file=sys.stderr)
        return 1

    def run(cmd: str) -> str:
        _in, out, err = cli.exec_command(cmd)
        out.channel.recv_exit_status()
        return (out.read().decode() + err.read().decode()).strip()

    sftp = cli.open_sftp()
    # stage to the user's home (writable), then sudo-move into /opt/superdevice.
    for name in files:
        local = HERE / name
        if not local.exists():
            print(f"skip {name} (not found)")
            continue
        tmp = f"/home/{args.user}/{name}"
        sftp.put(str(local), tmp)
        run(f"sudo mkdir -p {REMOTE_DIR} && sudo mv {tmp} {REMOTE_DIR}/{name}")
        if name.endswith(".sh"):
            run(f"sudo chmod +x {REMOTE_DIR}/{name}")
        print(f"uploaded {name}")

    # syntax-check the main file before restarting so we never install a broken UI.
    # sudo: the service's own compiles leave a root-owned __pycache__ in /opt,
    # which a user-level py_compile can't write to (false "syntax" failure).
    chk = run(f"sudo python3 -m py_compile {REMOTE_DIR}/superdevice_ui.py && echo OK")
    if "OK" not in chk:
        print(f"SYNTAX CHECK FAILED — not restarting:\n{chk}", file=sys.stderr)
        sftp.close(); cli.close()
        return 1

    if args.all:
        run("sudo systemctl daemon-reload")
    print(run("sudo systemctl restart superdevice-ui && sleep 1 && systemctl is-active superdevice-ui"))
    # quick smoke test of the new route
    print("isotp route:", run("curl -s -X POST -H 'Content-Type: application/json' "
                              "-d '{\"iface\":\"can0\",\"tx\":\"7E0\",\"rx\":\"7E8\",\"data\":\"3E00\"}' "
                              "http://127.0.0.1:8080/api/isotp | head -c 200"))
    sftp.close(); cli.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
