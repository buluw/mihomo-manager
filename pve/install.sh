#!/bin/bash
set -euo pipefail
[[ $EUID == 0 && -d /etc/pve ]] || { echo '请在 PVE 宿主机以 root 运行。' >&2; exit 2; }
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ -f $here/manage.py ]]; then
    exec python3 "$here/manage.py" "$@"
fi
work=$(mktemp -d /var/tmp/mihomo-pve-entry.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT
curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 120 https://raw.githubusercontent.com/buluw/mihomo-manager/main/pve/manage.py -o "$work/manage.py"
python3 "$work/manage.py" "$@"
