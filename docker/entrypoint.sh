#!/bin/sh
# Start the virtual desktop (Xvfb + fluxbox), share it over noVNC on :6080,
# then hand over to the console. XBOT_HEADLESS=1 skips the desktop.
set -e

if [ "${XBOT_HEADLESS:-0}" != "1" ]; then
  rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
  Xvfb "${DISPLAY:-:1}" -screen 0 "${SCREEN:-1600x900x24}" -nolisten tcp &
  for i in $(seq 1 50); do [ -e /tmp/.X11-unix/X1 ] && break; sleep 0.1; done
  fluxbox >/dev/null 2>&1 &
  x11vnc -display "${DISPLAY:-:1}" -forever -shared -nopw -quiet -localhost -rfbport 5900 >/dev/null 2>&1 &
  websockify --web /usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &
fi

exec "$@"
