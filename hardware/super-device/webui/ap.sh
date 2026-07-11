#!/bin/bash
# SuperDevice setup-hotspot control (NetworkManager / Bookworm).
#   ap.sh start | stop | ssid | pass
# Starting the hotspot first caches a scan of nearby networks so the config UI
# can still show WiFi options while the radio is busy being an AP (single-radio).
set -u
IFACE=wlan0
CACHE=/run/superdevice
MAC=$(cat "/sys/class/net/$IFACE/address" 2>/dev/null | tr -d ':')
SUFFIX=$(printf '%s' "${MAC: -4}" | tr 'a-z' 'A-Z')
SSID="SuperDevice-Setup-${SUFFIX:-0000}"
PASS="superdevice"

case "${1:-}" in
  ssid) echo "$SSID" ;;
  pass) echo "$PASS" ;;
  start)
    mkdir -p "$CACHE"
    nmcli -t -f SSID,SIGNAL,SECURITY dev wifi list --rescan yes > "$CACHE/wifi-cache" 2>/dev/null || true
    nmcli device wifi hotspot ifname "$IFACE" ssid "$SSID" password "$PASS"
    ;;
  stop)
    nmcli con down Hotspot 2>/dev/null || true
    nmcli con delete Hotspot 2>/dev/null || true
    ;;
  *) echo "usage: ap.sh start|stop|ssid|pass" >&2; exit 1 ;;
esac
