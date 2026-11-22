#!/bin/bash
#
# Starts a QA environment of the extension, for manual or agent driven QA: tmail-backend (memory, IMAP METADATA of the
# labels and identities, JMAP), then Thunderbird on a virtual X display in a container on its network, the extension
# built by build.sh installed, the accounts alice and bob configured, their labels, a custom identity and mails seeded.
#
#   scripts/qa-environment/build.sh && scripts/qa-environment/start.sh
#
# Accounts: alice@example.com and bob@example.com, the password is secret (IMAP and SMTP `james`, without TLS: a
# sandbox). Watch or drive the desktop with a VNC viewer on 127.0.0.1:$QA_VNC_PORT (no password); agents drive it
# through its MCP server (stdio): docker exec -i <container> /opt/desktop/desktop-mcp.py (screenshots, mouse,
# keyboard, the AT-SPI accessibility tree, Thunderbird's console).
#
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/common.sh"
DOMAIN=example.com
USERS="alice bob"
PASSWORD=secret
RUN="$WORK/run"
CAPTURES_DIR="${CAPTURES_DIR:-$RUN/captures}"
DESKTOP_IMAGE="$(cat "$WORK/desktop-image" 2>/dev/null || true)"
[ -f "$XPI" ] && [ -n "$DESKTOP_IMAGE" ] && docker image inspect "$DESKTOP_IMAGE" >/dev/null 2>&1 \
  || { echo "Not built: run scripts/qa-environment/build.sh first" >&2; exit 1; }

docker rm -f "$DESKTOP_CONTAINER" "$JAMES" >/dev/null 2>&1 || true
rm -rf "$RUN"
mkdir -p "$RUN/qa" "$RUN/james" "$CAPTURES_DIR"
docker network inspect "$QA_NETWORK" >/dev/null 2>&1 || docker network create "$QA_NETWORK" >/dev/null

echo "==> tmail-backend ($TMAIL_IMAGE)"
openssl genrsa -out "$RUN/james/jwt_privatekey" 2048 2>/dev/null
openssl rsa -in "$RUN/james/jwt_privatekey" -pubout -out "$RUN/james/jwt_publickey" 2>/dev/null
# IMAP authentication without TLS (the image refuses it by default): Thunderbird reaches it in clear, on its network
docker run --rm --entrypoint cat "$TMAIL_IMAGE" /root/conf/imapserver.xml \
  | sed 's#<plainAuthDisallowed>true</plainAuthDisallowed>#<plainAuthDisallowed>false</plainAuthDisallowed>#' > "$RUN/james/imapserver.xml"
chmod 644 "$RUN/james/"*
docker run -d --name "$JAMES" --network "$QA_NETWORK" --network-alias james \
  -p "127.0.0.1:$QA_JMAP_PORT:80" -p "127.0.0.1:$QA_WEBADMIN_PORT:8000" \
  -v "$RUN/james/jwt_publickey:/root/conf/jwt_publickey:ro" -v "$RUN/james/jwt_privatekey:/root/conf/jwt_privatekey:ro" \
  -v "$RUN/james/imapserver.xml:/root/conf/imapserver.xml:ro" "$TMAIL_IMAGE" >/dev/null
echo -n "    waiting for it"
for _ in $(seq 1 90); do
  curl -fsS -o /dev/null "http://127.0.0.1:$QA_WEBADMIN_PORT/healthcheck" 2>/dev/null && { up=true; break; }
  echo -n "."; sleep 2
done
[ "${up:-false}" = true ] || { echo; docker logs --tail 40 "$JAMES" >&2; exit 1; }
echo " up"
curl -fsS -o /dev/null -X PUT "http://127.0.0.1:$QA_WEBADMIN_PORT/domains/$DOMAIN"
for uid in $USERS; do
  curl -fsS -o /dev/null -X PUT "http://127.0.0.1:$QA_WEBADMIN_PORT/users/$uid@$DOMAIN" \
    -H 'Content-Type: application/json' -d "{\"password\":\"$PASSWORD\"}"
done

echo "==> Labels, identities and mails (JMAP)"
python3 -I "$HERE/seed.py" --jmap "http://127.0.0.1:$QA_JMAP_PORT" --domain "$DOMAIN" --password "$PASSWORD" $USERS

echo "==> The Thunderbird profile"
cp "$XPI" "$RUN/qa/extension.xpi"
# as the caller (its files): any uid, a home of its own in /tmp
AS_CALLER=(--user "$(id -u):$(id -g)" -e HOME=/tmp/qa-home -e XDG_CONFIG_HOME=/home/qa/.config)
docker run --rm "${AS_CALLER[@]}" --network "$QA_NETWORK" -v "$RUN/qa:/qa" --entrypoint python3 "$DESKTOP_IMAGE" \
  /opt/desktop/profile.py "$DOMAIN" "$PASSWORD" $USERS

echo "==> Thunderbird ($DESKTOP_CONTAINER)"
VNC=()
[ -n "$QA_VNC_PORT" ] && VNC=(-e DESKTOP_VNC=1 -p "127.0.0.1:$QA_VNC_PORT:5900")
docker run -d --name "$DESKTOP_CONTAINER" "${AS_CALLER[@]}" "${VNC[@]}" --network "$QA_NETWORK" --shm-size 1g \
  -v "$RUN/qa:/qa" -v "$CAPTURES_DIR:$CAPTURES_DIR" -e CAPTURES_DIR="$CAPTURES_DIR" "$DESKTOP_IMAGE" >/dev/null
echo -n "    waiting for its window"
for _ in $(seq 1 60); do
  if docker exec "$DESKTOP_CONTAINER" bash -c '. /tmp/desktop.env 2>/dev/null && xdotool search --onlyvisible --class thunderbird' >/dev/null 2>&1; then
    ready=true; break
  fi
  echo -n "."; sleep 2
done
[ "${ready:-false}" = true ] || { echo; docker exec "$DESKTOP_CONTAINER" tail -40 /tmp/thunderbird.log >&2; exit 1; }
echo " up"

cat <<INFO

==> The QA environment is up

  Thunderbird: $(docker exec "$DESKTOP_CONTAINER" cat /etc/thunderbird-version), container $DESKTOP_CONTAINER (1440x900)
               ${QA_VNC_PORT:+VNC: 127.0.0.1:$QA_VNC_PORT (no password)}
  Accounts:    alice@$DOMAIN, bob@$DOMAIN / $PASSWORD (IMAP and SMTP james, no TLS)
  JMAP:        http://127.0.0.1:$QA_JMAP_PORT/jmap (basic authentication; Label/set, Identity/set to change the server side)
  WebAdmin:    http://127.0.0.1:$QA_WEBADMIN_PORT
  Agents:      docker exec -i $DESKTOP_CONTAINER /opt/desktop/desktop-mcp.py  (an MCP server, stdio)
  Screenshots: $CAPTURES_DIR

Stop it with: scripts/qa-environment/stop.sh
INFO
