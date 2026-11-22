# Shared by build.sh, start.sh and stop.sh (sourced).
REPO_DIR="$(cd "$HERE/../.." && pwd)"
QA_PROJECT="${QA_PROJECT:-tmail-label-qa}"              # prefix of the containers and of the network
QA_NETWORK="${QA_NETWORK:-${QA_PROJECT}_default}"
QA_JMAP_PORT="${QA_JMAP_PORT:-18900}"                   # tmail-backend JMAP, on 127.0.0.1
QA_WEBADMIN_PORT="${QA_WEBADMIN_PORT:-18901}"           # tmail-backend WebAdmin, on 127.0.0.1
QA_VNC_PORT="${QA_VNC_PORT:-15900}"                     # the desktop over VNC, on 127.0.0.1 (empty: none)
TMAIL_IMAGE="${TMAIL_IMAGE:-linagora/tmail-backend:memory-1.0.22.2}"
THUNDERBIRD_VERSION="${THUNDERBIRD_VERSION:-debian}"
JAMES="$QA_PROJECT-james"
DESKTOP_CONTAINER="${DESKTOP_CONTAINER:-$QA_PROJECT-thunderbird}"
WORK="${QA_WORK:-${XDG_CACHE_HOME:-$HOME/.cache}/thunderbird-tmail-label-qa}"   # the XPI, the keys, the profile
XPI="$WORK/twake-mail-thunderbird.xpi"
mkdir -p "$WORK"
