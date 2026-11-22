#!/bin/bash
#
# Installs the Thunderbird of the image (Dockerfile, as root): `debian`, the package of Debian (its libraries are
# installed anyway: the dependencies of the others), or a version of Mozilla (e.g. 128.5.0esr, 145.0, 146.0b3),
# its Linux build from archive.mozilla.org, checked against the SHA512SUMS of the release. Then the AutoConfig of
# the QA environment (mozilla.cfg, which start.sh writes), updates off, and the version in /etc/thunderbird-version.
#
set -euo pipefail
VERSION="${1:-debian}"
if [ "$VERSION" = debian ]; then
  DIR=/usr/lib/thunderbird
else
  BASE="https://archive.mozilla.org/pub/thunderbird/releases/$VERSION"
  curl -fsSL -o /tmp/SHA512SUMS "$BASE/SHA512SUMS"
  for ext in tar.xz tar.bz2; do
    FILE="linux-x86_64/en-US/thunderbird-$VERSION.$ext"
    if grep -q " $FILE\$" /tmp/SHA512SUMS; then break; fi
    FILE=""
  done
  [ -n "$FILE" ] || { echo "no Linux x86_64 build of Thunderbird $VERSION in $BASE/SHA512SUMS" >&2; exit 1; }
  curl -fsSL -o "/tmp/thunderbird.${FILE##*.}" "$BASE/$FILE"
  echo "$(grep " $FILE\$" /tmp/SHA512SUMS | cut -d' ' -f1)  /tmp/thunderbird.${FILE##*.}" | sha512sum -c --quiet
  mkdir -p /opt
  tar -xf "/tmp/thunderbird.${FILE##*.}" -C /opt
  rm -f /tmp/thunderbird.* /tmp/SHA512SUMS
  ln -sf /opt/thunderbird/thunderbird /usr/local/bin/thunderbird
  DIR=/opt/thunderbird
fi
mkdir -p "$DIR/defaults/pref" "$DIR/distribution"
printf '%s\n' 'pref("general.config.filename", "mozilla.cfg");' 'pref("general.config.obscure_value", 0);' \
  'pref("general.config.sandbox_enabled", false);' > "$DIR/defaults/pref/autoconfig.js"
ln -sf /qa/mozilla.cfg "$DIR/mozilla.cfg"
echo '{"policies": {"DisableAppUpdate": true, "DisableTelemetry": true}}' > "$DIR/distribution/policies.json"
thunderbird --version 2>/dev/null | tail -1 > /etc/thunderbird-version
echo "installed: $(cat /etc/thunderbird-version) ($DIR)"
