#!/bin/bash
# Fixed manager-program transaction. Locks also exclude deployment and Core control.
set -eu
exec 9>/run/lock/mihomo-manager-deploy.lock
exec 8>/run/lock/mihomo-manager-core-control.lock
if ! /usr/bin/flock -n 9 || ! /usr/bin/flock -n 8; then
    printf '{"error":"busy"}\n'
    exit 1
fi
case "${1:-}" in
    '') exec /opt/mihomo-manager/node/bin/node /usr/local/libexec/mihomo-manager-webui/deploy/debian/webui-install.mjs ;;
    recover) exec /opt/mihomo-manager/node/bin/node /usr/local/libexec/mihomo-manager-webui/deploy/debian/webui-install.mjs recover ;;
    *) exit 2 ;;
esac
