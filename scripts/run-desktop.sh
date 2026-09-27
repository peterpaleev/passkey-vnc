#!/usr/bin/env bash
set -euo pipefail
umask 077

display_number=${REMOTE_DISPLAY_NUMBER:-99}
if [[ ! $display_number =~ ^[0-9]{1,3}$ ]]; then
  echo 'REMOTE_DISPLAY_NUMBER must be 0–999' >&2
  exit 2
fi
export DISPLAY=":${display_number}"
export LIBGL_ALWAYS_SOFTWARE=1
runtime_dir=${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is required}
private_dir=$(mktemp -d "$runtime_dir/remote-desk.XXXXXX")
export XAUTHORITY="$private_dir/Xauthority"
touch "$XAUTHORITY"
cookie=$(mcookie)
xauth -f "$XAUTHORITY" add "$DISPLAY" . "$cookie" >/dev/null
unset cookie

children=()
cleanup() {
  trap - EXIT INT TERM
  for pid in "${children[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${children[@]}"; do wait "$pid" 2>/dev/null || true; done
  rm -f -- "$XAUTHORITY"
  rmdir -- "$private_dir"
}
trap cleanup EXIT INT TERM

Xvfb "$DISPLAY" -screen 0 "${REMOTE_SCREEN:-1600x900x24}" -nolisten tcp -auth "$XAUTHORITY" &
children+=("$!")
for i in {1..50}; do
  if timeout 2s xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
timeout 2s xdpyinfo -display "$DISPLAY" >/dev/null
openbox --sm-disable --config-file /etc/xdg/openbox/rc.xml &
children+=("$!")
if command -v xterm >/dev/null; then
  xterm -geometry 100x30+80+80 -title 'Remote Desk terminal' &
fi
x11vnc -display "$DISPLAY" -auth "$XAUTHORITY" -localhost \
  -rfbport "${REMOTE_VNC_PORT:-5901}" -forever -shared -nopw -noxdamage -repeat -quiet &
children+=("$!")
wait -n "${children[@]}"
echo 'Desktop component exited; systemd will restart it' >&2
exit 1
