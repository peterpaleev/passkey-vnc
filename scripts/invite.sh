#!/usr/bin/env bash
set -euo pipefail
config="$HOME/.config/remote-desk/environment"
[[ -r $config ]] || { echo "Missing $config. Run scripts/install-ubuntu.sh first." >&2; exit 2; }
set -a
# The local, owner-only installer writes this file. Do not source untrusted files.
source "$config"
set +a
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
exec /usr/bin/node "$repo_dir/server.mjs" --invite
