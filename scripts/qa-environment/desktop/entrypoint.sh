#!/bin/bash
#
# The desktop of the container: Xvfb, a session bus with the accessibility bus, openbox, then Thunderbird on the
# profile /qa/profile (start.sh prepares it). desktop-mcp.py (docker exec) finds the bus in /tmp/desktop.env.
# Thunderbird is started again when it exits (the agent may quit it); its output goes to /tmp/thunderbird.log.
#
set -euo pipefail
SIZE="${DESKTOP_SIZE:-1440x900}"
mkdir -p "${HOME:-/tmp/qa-home}"
# run as any uid (that of the caller): dbus needs a user and a group for it
getent passwd "$(id -u)" >/dev/null || echo "qa-$(id -u):x:$(id -u):$(id -g):QA:${HOME:-/tmp/qa-home}:/bin/bash" >> /etc/passwd
getent group "$(id -g)" >/dev/null || echo "qa-$(id -g):x:$(id -g):" >> /etc/group
Xvfb :99 -screen 0 "${SIZE}x24" -nolisten tcp &
for _ in $(seq 1 50); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS
/usr/libexec/at-spi-bus-launcher --launch-immediately &
sleep 1
printf 'export DISPLAY=%q\nexport DBUS_SESSION_BUS_ADDRESS=%q\n' "$DISPLAY" "$DBUS_SESSION_BUS_ADDRESS" > /tmp/desktop.env
openbox &
# VNC (start.sh publishes it on 127.0.0.1 when QA_VNC_PORT is set): to watch or drive the desktop by hand
[ "${DESKTOP_VNC:-0}" = 1 ] && x11vnc -display :99 -forever -shared -nopw -quiet -rfbport 5900 >/dev/null 2>&1 &
touch /tmp/thunderbird.log
echo "==> $(cat /etc/thunderbird-version 2>/dev/null)" >> /tmp/thunderbird.log
while true; do
  if [ ! -e /tmp/thunderbird.stopped ]; then
    echo "==> $(date -u +%FT%TZ) $(cat /etc/thunderbird-version 2>/dev/null || echo Thunderbird) starts" >> /tmp/thunderbird.log
    thunderbird --no-remote --profile /qa/profile >> /tmp/thunderbird.log 2>&1 || true
    echo "==> $(date -u +%FT%TZ) Thunderbird exited" >> /tmp/thunderbird.log
  fi
  sleep 2
done
