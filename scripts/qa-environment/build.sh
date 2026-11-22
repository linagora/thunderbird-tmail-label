#!/bin/bash
#
# Builds what start.sh runs: the extension's XPI from the working tree, and the Thunderbird image (desktop/: Thunderbird
# on a virtual X display, VNC, and an MCP server for agents). tmail-backend is pulled by start.sh.
#
#   scripts/qa-environment/build.sh                                  # the Thunderbird of Debian trixie (an ESR)
#   THUNDERBIRD_VERSION=128.5.0esr scripts/qa-environment/build.sh   # a version of Mozilla (archive.mozilla.org)
#   THUNDERBIRD_VERSION=latest scripts/qa-environment/build.sh       # esr, latest, beta: the current ones of Mozilla
#
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/common.sh"

echo "==> The extension: $XPI"
rm -f "$XPI"
(cd "$REPO_DIR" && zip -qr "$XPI" manifest.json _locales icons src experiment-apis -x '*.DS_Store')

case "$THUNDERBIRD_VERSION" in
  esr|latest|beta)
    version="$(curl -fsSL https://product-details.mozilla.org/1.0/thunderbird_versions.json | python3 -c "
import json, sys
v = json.load(sys.stdin)
print({'esr': v.get('THUNDERBIRD_ESR'), 'latest': v.get('LATEST_THUNDERBIRD_VERSION'),
       'beta': v.get('LATEST_THUNDERBIRD_DEVEL_VERSION')}['$THUNDERBIRD_VERSION'] or '')")" ;;
  *) version="$THUNDERBIRD_VERSION" ;;
esac
[ -n "$version" ] || { echo "Thunderbird $THUNDERBIRD_VERSION: no such version at Mozilla" >&2; exit 1; }
image="thunderbird-tmail-label-qa:$version"
echo "==> The Thunderbird image $image"
docker build -q --build-arg THUNDERBIRD_VERSION="$version" -t "$image" "$HERE/desktop" >/dev/null
echo "$image" > "$WORK/desktop-image"
echo "    $(docker run --rm --entrypoint cat "$image" /etc/thunderbird-version)"
