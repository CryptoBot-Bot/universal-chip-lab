#!/bin/bash
# WiFi fallback: if no known network connects within the grace window (e.g. the
# device was moved to a new shop), bring up the setup hotspot for provisioning.
# Runs once at boot (systemd oneshot). Never starts an AP while a client WiFi is up.
set -u
IFACE=wlan0
GRACE=60

is_client() {
  local c
  c=$(nmcli -t -f DEVICE,STATE,CONNECTION dev status | awk -F: -v i="$IFACE" '$1==i && $2=="connected"{print $3}')
  [ -n "$c" ] && ! printf '%s' "$c" | grep -qi hotspot
}

for _ in $(seq 1 "$GRACE"); do
  if is_client; then
    logger -t superdevice-netwatch "WiFi client connected; no setup AP needed"
    exit 0
  fi
  sleep 1
done

logger -t superdevice-netwatch "offline after ${GRACE}s — starting setup hotspot"
exec /opt/superdevice/ap.sh start
