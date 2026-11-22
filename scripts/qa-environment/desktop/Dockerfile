# Thunderbird on a virtual X server, driven by desktop-mcp.py (screenshots, mouse, keyboard, the AT-SPI
# accessibility tree). The extension under test and the profile are mounted by start.sh.
#
# THUNDERBIRD_VERSION: `debian` (the package of Debian trixie, an ESR) or a version of Mozilla (128.5.0esr,
# 145.0...: install-thunderbird.sh); build.sh resolves esr, latest and beta to the current ones.
FROM debian:trixie-slim

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      thunderbird thunderbird-l10n-fr \
      xvfb openbox xdotool x11-utils x11vnc imagemagick \
      dbus dbus-x11 at-spi2-core python3 python3-pyatspi gir1.2-atspi-2.0 \
      fonts-dejavu fonts-liberation fonts-noto-color-emoji ca-certificates curl procps xz-utils bzip2 \
 && rm -rf /var/lib/apt/lists/*

ARG THUNDERBIRD_VERSION=debian
COPY install-thunderbird.sh /tmp/
RUN bash /tmp/install-thunderbird.sh "$THUNDERBIRD_VERSION" && rm /tmp/install-thunderbird.sh

RUN useradd -m -u 1000 qa \
 && mkdir -p /home/qa/.config/openbox \
 && sed 's#</applications>#<application class="*" type="normal"><maximized>yes</maximized><decor>no</decor></application></applications>#' \
      /etc/xdg/openbox/rc.xml > /home/qa/.config/openbox/rc.xml \
 && chmod -R a+rX /home/qa/.config
COPY desktop-mcp.py entrypoint.sh profile.py /opt/desktop/
RUN chmod 755 /opt/desktop/entrypoint.sh /opt/desktop/desktop-mcp.py /opt/desktop/profile.py
USER qa
ENV DISPLAY=:99 LANG=C.UTF-8 GNOME_ACCESSIBILITY=1 MOZ_ENABLE_WAYLAND=0
ENTRYPOINT ["/opt/desktop/entrypoint.sh"]
