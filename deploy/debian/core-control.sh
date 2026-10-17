#!/bin/bash
# Root entry point for exactly one project's Core. No caller-selected paths or units.
set -eu
IFS= read -r -t 5 -n 16 action || exit 1
case "$action" in start|restart|install|rollback) ;; *) printf 'invalid\n'; exit 0 ;; esac
exec 9>/run/lock/mihomo-manager-core-control.lock
if ! /usr/bin/flock -n 9; then printf 'busy\n'; exit 0; fi
if [[ "$action" == install || "$action" == rollback ]]; then
    exec /opt/mihomo-manager/node/bin/node /usr/local/libexec/mihomo-manager-core-install.mjs "$action"
fi
/usr/bin/systemctl reset-failed mihomo-manager-core.service >/dev/null 2>&1 || true
if /usr/bin/timeout 25 /usr/bin/systemctl "$action" mihomo-manager-core.service >/dev/null 2>&1; then
    printf 'ok\n'
else
    printf 'failed\n'
fi
