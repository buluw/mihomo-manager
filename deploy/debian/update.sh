#!/bin/bash
set -euo pipefail
export PATH=/opt/mihomo-manager/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
stage=$(realpath "${1:?transfer directory required}")
validation_scope=${2:-full}
[[ "$validation_scope" == full || "$validation_scope" == frontend || "$validation_scope" == collections || "$validation_scope" == memory ]] || exit 2
[[ "$stage" =~ ^/tmp/mihomo-manager-deploy-[a-f0-9]{32}$ ]] || exit 2
[[ $EUID == 0 && -f "$stage/source/deploy/debian/update.sh" ]] || exit 2
trap 'rm -rf -- "$stage"' EXIT
exec 9>/run/lock/mihomo-manager-deploy.lock
flock -n 9 || { echo 'Another manager deployment is running.' >&2; exit 1; }
app=/opt/mihomo-manager/app
data=/var/lib/mihomo-manager
settings=/etc/mihomo-manager
if [[ -e "$settings/runtime-only" ]]; then
    echo 'This container is runtime-only. Build elsewhere; source deployment would reinstall development dependencies.' >&2
    exit 1
fi
first=0
if [[ ! -f "$settings/deployment-owned" ]]; then
    for directory in /opt/mihomo-manager "$data" "$settings"; do
        [[ ! -e "$directory" ]] || { echo 'Existing unmanaged project directory needs review.' >&2; exit 1; }
    done
    first=1
fi

echo 'Checking required Debian packages.'
packages=()
for package in ca-certificates curl git jq ripgrep nginx-light sqlite3 tcpdump rsync; do
    if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
        packages+=("$package")
    fi
done
new_nginx=0
command -v nginx >/dev/null || new_nginx=1
if ((${#packages[@]})); then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >"$stage/packages.log" 2>&1
    if ! apt-get install -y --no-install-recommends "${packages[@]}" >>"$stage/packages.log" 2>&1; then
        echo 'Required package installation failed; package names only follow.' >&2
        printf '%s\n' "${packages[@]}" >&2
        exit 1
    fi
    printf 'Installed: %s\n' "${packages[*]}"
fi
if ((new_nginx)); then systemctl disable --now nginx >/dev/null 2>&1; fi

if ((first)); then
    install -d -m 755 /opt/mihomo-manager "$app" /opt/mihomo-manager/bin "$settings"
    if ! getent passwd mihomo-manager >/dev/null; then
        useradd --system --home-dir "$data" --no-create-home --shell /usr/sbin/nologin mihomo-manager
    fi
    for directory in "$data" "$data/configs" "$data/providers" "$data/ruleset" "$data/generated-runtime" "$data/logs"; do
        install -d -o mihomo-manager -g mihomo-manager -m 700 "$directory"
    done
    install -o root -g mihomo-manager -m 640 "$stage/source/deploy/debian/manager.env.example" "$settings/manager.env"
    install -o mihomo-manager -g mihomo-manager -m 600 "$stage/source/deploy/debian/test/development.yaml" "$data/configs/debian-development.yaml"
    # An immutable bootstrap is used only before the first load record exists.
    install -o root -g mihomo-manager -m 640 "$stage/source/deploy/debian/test/development.yaml" "$data/bootstrap.yaml"
    touch "$settings/deployment-owned"
fi

if [[ ! -x /opt/mihomo-manager/node/bin/node ]]; then
    echo 'Installing official Node 24.15.0.'
    curl -fsSL --connect-timeout 20 --max-time 180 https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz -o "$stage/node.tar.xz"
    echo '472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6  '"$stage/node.tar.xz" | sha256sum -c - >/dev/null
    install -d -m 755 /opt/mihomo-manager/node
    tar -xJf "$stage/node.tar.xz" --strip-components=1 -C /opt/mihomo-manager/node
    for tool in node npm npx; do
        [[ -e "/usr/local/bin/$tool" ]] || ln -s "/opt/mihomo-manager/node/bin/$tool" "/usr/local/bin/$tool"
    done
fi
[[ $(node -p 'process.versions.node.split(".")[0]') == 24 ]] || { echo 'Node 24 is required.' >&2; exit 1; }
if [[ ! -x /opt/mihomo-manager/bin/mihomo ]]; then
    echo 'Installing official Mihomo 1.19.29.'
    curl -fsSL --connect-timeout 20 --max-time 180 https://github.com/MetaCubeX/mihomo/releases/download/v1.19.29/mihomo-linux-amd64-compatible-v1.19.29.gz -o "$stage/mihomo.gz"
    echo '5612e698e96c8b8ad15abc4c0a4f098eba9234354b4f248cb97f2528e215b094  '"$stage/mihomo.gz" | sha256sum -c - >/dev/null
    gzip -dc "$stage/mihomo.gz" >"$stage/mihomo"
    install -m 755 "$stage/mihomo" /opt/mihomo-manager/bin/mihomo
fi
install -d -o mihomo-manager -g mihomo-manager -m 700 "$data/core-update"
access_deployment="$stage/source/deploy/debian/access-deployment.mjs"
access_directory=$(node "$access_deployment" directory "$settings/manager.env")
node "$access_deployment" prepare "$access_directory"
if ! grep -q '^[[:space:]]*CORE_UPDATE_DIR=' "$settings/manager.env"; then
    printf '\nCORE_UPDATE_DIR=/var/lib/mihomo-manager/core-update\n' >>"$settings/manager.env"
fi

echo 'Updating the fixed application directory and Linux dependencies.'
node "$stage/source/deploy/debian/sync-source.mjs" "$stage/source"
for component in configd logd sysinfo frontend; do
    cd "$app/$component"
    dependency_hash=$(sha256sum package.json package-lock.json | sha256sum | cut -d' ' -f1)
    if [[ ! -d node_modules || ! -f .dependencies.sha256 || $(cat .dependencies.sha256) != "$dependency_hash" ]]; then
        npm ci --no-audit --no-fund >"$stage/$component-install.log" 2>&1 || { echo "$component dependency installation failed." >&2; exit 1; }
        printf '%s\n' "$dependency_hash" >.dependencies.sha256
    fi
    if [[ "$validation_scope" == frontend && "$component" == frontend ]]; then
        node --experimental-strip-types --test test/collections.test.ts test/collectionViewModel.test.ts test/config.test.ts
        npm run lint
    fi
    if [[ "$validation_scope" == collections && "$component" == frontend ]]; then
        node --experimental-strip-types --test test/collections.test.ts test/collectionViewModel.test.ts test/proxyCollectionImport.test.ts test/config.test.ts
        node --experimental-strip-types --test --test-name-pattern='rule|website|domain' test/ui-migration.test.ts
        npm run lint
    fi
    if [[ "$validation_scope" == collections && "$component" == configd ]]; then
        node --import tsx --test test/providerFiles.test.ts test/proxyCollectionImport.test.ts test/configSaveCollections.test.ts
        npm run lint
    fi
    # tsc does not remove obsolete outputs; remove only this app's generated dist.
    if [[ "$validation_scope" == memory ]]; then
        case "$component" in
            sysinfo) node --import tsx --test test/coreUpdate.test.ts test/resources.test.ts; npm run lint ;;
            logd) npm test; npm run lint ;;
            frontend) node --experimental-strip-types --test test/systemClient.test.ts; npm run lint ;;
        esac
    fi
    rm -rf -- "$app/$component/dist"
    npm run build >"$stage/$component-build.log" 2>&1 || { cat "$stage/$component-build.log" >&2; exit 1; }
    echo "$component production build passed."
done
cd "$app"
if [[ "$validation_scope" == memory ]]; then
    node --test deploy/debian/test/core-install.test.mjs
fi
if [[ "$validation_scope" == full ]]; then
    node --test deploy/debian/test/startup-config.test.mjs
    node --test deploy/debian/test/core-install.test.mjs
    node --import ./logd/node_modules/tsx/dist/loader.mjs --test logd/test/store.test.ts
    node --import ./sysinfo/node_modules/tsx/dist/loader.mjs --test sysinfo/test/*.test.ts
fi

# Existing deployment values are retained; only the new service's missing keys are added.
if ! grep -q '^[[:space:]]*SYSINFO_HOST=' "$settings/manager.env"; then
    printf '\nSYSINFO_HOST=127.0.0.1\n' >>"$settings/manager.env"
fi
if ! grep -q '^[[:space:]]*SYSINFO_PORT=' "$settings/manager.env"; then
    printf '\nSYSINFO_PORT=9083\n' >>"$settings/manager.env"
fi
node --input-type=module - "$app/deploy/debian/nginx.conf" "$settings/manager.env" "$stage/nginx.conf" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
const [template, environment, output] = process.argv.slice(2);
const lines = readFileSync(environment, 'utf8').split(/\r?\n/);
const value = (name) => lines.findLast((line) => line.trimStart().startsWith(`${name}=`))
  ?.trim().slice(name.length + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
const host = value('SYSINFO_HOST');
const port = Number(value('SYSINFO_PORT'));
if (!isIP(host ?? '') || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Invalid sysinfo listen configuration');
}
const upstream = `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
writeFileSync(output, readFileSync(template, 'utf8').replaceAll('__SYSINFO_UPSTREAM__', upstream));
JS
install -m 644 "$stage/nginx.conf" "$settings/nginx.conf"
install -d -o root -g root -m 755 /usr/local/libexec
install -o root -g root -m 755 "$app/deploy/debian/core-control.sh" /usr/local/libexec/mihomo-manager-core-control
install -o root -g root -m 644 "$app/deploy/debian/core-install.mjs" /usr/local/libexec/mihomo-manager-core-install.mjs
for unit in "$app"/deploy/debian/mihomo-manager*.service "$app"/deploy/debian/mihomo-manager*.socket "$app"/deploy/debian/mihomo-manager.target; do
    install -m 644 "$unit" /etc/systemd/system/
done
node "$app/deploy/debian/access-deployment.mjs" permissions "$access_directory" /etc/systemd/system/mihomo-manager-sysinfo.service.d/20-access-data.conf
node "$app/deploy/debian/webui-deployment.mjs" "$app"
# Apply after static-nodes-permissions.conf so its z rule cannot restore 0666.
install -m 644 "$app/deploy/debian/zz-mihomo-manager-tun.conf" /etc/tmpfiles.d/zz-mihomo-manager-tun.conf
systemd-tmpfiles --create /etc/tmpfiles.d/zz-mihomo-manager-tun.conf
systemctl daemon-reload
systemctl enable mihomo-manager.target >/dev/null
systemctl restart mihomo-manager.target
if node "$app/deploy/debian/health.mjs"; then
    systemctl is-active mihomo-manager-{core,configd,logd,sysinfo,web}.service
    echo 'Deployment ready: open port 9090 on this container IPv4 address.'
    exit 0
fi
echo 'Manager startup did not become ready; service status only follows.' >&2
systemctl show mihomo-manager-{core,configd,logd,sysinfo,web}.service -p Id -p ActiveState -p SubState -p ExecMainStatus >&2
exit 1
