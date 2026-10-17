#!/bin/bash
set -euo pipefail
[[ $EUID == 0 && -f /etc/mihomo-manager/pve-template ]] || exit 2
node=/opt/mihomo-manager/node/bin/node
app=/opt/mihomo-manager/app
install -d -o mihomo-manager -g mihomo-manager -m 700 /var/lib/mihomo-manager/access
"$node" "$app/deploy/debian/access-deployment.mjs" permissions /var/lib/mihomo-manager/access /etc/systemd/system/mihomo-manager-sysinfo.service.d/20-access-data.conf
"$node" "$app/deploy/debian/webui-deployment.mjs" "$app"
ssh-keygen -A
if command -v make-ssl-cert >/dev/null; then make-ssl-cert generate-default-snakeoil --force-overwrite; fi
sysctl -q -w net.ipv4.ip_forward=1
systemctl daemon-reload
touch /etc/mihomo-manager/pve-initialized
