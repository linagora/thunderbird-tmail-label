#!/bin/bash
#
# Stops what start.sh started: Thunderbird, tmail-backend (in memory: its data is gone) and their network.
#
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/common.sh"
docker rm -f "$DESKTOP_CONTAINER" "$JAMES" >/dev/null 2>&1
docker network rm "$QA_NETWORK" >/dev/null 2>&1
echo "==> QA environment '$QA_PROJECT' stopped"
