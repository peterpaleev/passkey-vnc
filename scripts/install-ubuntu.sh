#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if [[ $repo_dir != "$HOME/passkey-vnc" ]]; then
  echo "Clone this repository to $HOME/passkey-vnc, then run this script." >&2
  exit 2
fi
if [[ $# != 1 || ! $1 =~ ^https://[^/]+$ ]]; then
  echo 'Usage: scripts/install-ubuntu.sh https://remote.example.com' >&2
  exit 2
fi
origin=$1
for cmd in node npm Xvfb x11vnc xauth mcookie xdpyinfo openbox xterm systemctl loginctl; do
  command -v "$cmd" >/dev/null || { echo "Missing $cmd. See README.md prerequisites." >&2; exit 2; }
done
node_major=$(node -p 'process.versions.node.split(".")[0]')
(( node_major >= 22 )) || { echo 'Node.js 22 or newer is required.' >&2; exit 2; }
if [[ $(command -v node) != /usr/bin/node ]]; then
  echo 'The systemd service expects /usr/bin/node. Install a system Node.js 22+ package.' >&2
  exit 2
fi
cd "$repo_dir"
npm ci --omit=dev
install -d -m 700 "$HOME/.config/remote-desk" "$HOME/.local/share/remote-desk" "$HOME/.config/systemd/user"
config="$HOME/.config/remote-desk/environment"
if [[ -e $config ]]; then
  echo "Existing $config preserved. Set REMOTE_ORIGIN=$origin there if this domain changed."
else
  printf 'REMOTE_ORIGIN=%s\nREMOTE_DATA=%s\nREMOTE_PORT=8765\nREMOTE_VNC_PORT=5901\nREMOTE_TITLE="Remote Desk"\nREMOTE_USER=%s\n' \
    "$origin" "$HOME/.local/share/remote-desk" "$USER" > "$config"
  chmod 600 "$config"
fi
install -m 644 systemd/remote-desk-desktop.service "$HOME/.config/systemd/user/"
install -m 644 systemd/remote-desk-web.service "$HOME/.config/systemd/user/"
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now remote-desk-desktop.service remote-desk-web.service
systemctl --user --no-pager status remote-desk-desktop.service remote-desk-web.service
echo "Create a private enrollment link with: cd $repo_dir && npm run invite"
