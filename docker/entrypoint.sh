#!/bin/sh
# Wait for the VM desktop's X display, then hand over to the console.
# XBOT_HEADLESS=1 skips the wait (Chrome then runs without a window).
set -eu

# A Chrome profile remembers the host that last opened it in Singleton* files.
# A new container is a new hostname, so Chrome would refuse the profile as "in
# use by another computer". Nothing else can be running it yet: drop the locks.
find /app/profiles -maxdepth 3 -name 'Singleton*' -exec rm -f {} + 2>/dev/null || true

if [ "${XBOT_HEADLESS:-0}" != "1" ]; then
  # After a reboot the container can start before the desktop is up.
  NUM="${DISPLAY#*:}"; NUM="${NUM%%.*}"
  SOCKET="/tmp/.X11-unix/X${NUM}"
  i=0
  while [ ! -S "$SOCKET" ] && [ "$i" -lt 600 ]; do
    [ "$i" -eq 0 ] && echo "Waiting for the desktop's X display ($SOCKET) ..."
    i=$((i + 1)); sleep 1
  done
  [ -S "$SOCKET" ] || echo "WARNING: $SOCKET not found; browser windows will fail to open." >&2
  echo "Chrome opens on the VM desktop (DISPLAY=$DISPLAY)."
fi

exec "$@"
