#!/bin/bash
# Existing managed containers only: package on dev, install on runtime-only.
set -euo pipefail
export PATH=/opt/mihomo-manager/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
mode=${1:?pack, install or rollback required}
work=$(realpath "${2:?staging or backup directory required}")
app=/opt/mihomo-manager/app
settings=/etc/mihomo-manager
access_permissions=/etc/systemd/system/mihomo-manager-sysinfo.service.d/20-access-data.conf
[[ $EUID == 0 && -f "$settings/deployment-owned" ]] || exit 2
[[ $(realpath "$app") == "$app" && ! -L "$app" ]] || exit 2
if [[ ${MIHOMO_PVE_LOCKS:-} == 1 ]]; then
    [[ $(readlink /proc/$$/fd/9) == /run/lock/mihomo-manager-deploy.lock ]] || exit 2
else
    exec 9>/run/lock/mihomo-manager-deploy.lock
fi
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }

health() {
    node "$work/health.mjs"
    systemctl is-active mihomo-manager-{core,configd,logd,sysinfo,web}.service
}

if [[ "$mode" == pack ]]; then
    [[ "$work" =~ ^/tmp/mihomo-runtime-[a-f0-9]{32}$ && ! -e "$settings/runtime-only" ]] || exit 2
    # Optional isolated build tree keeps the running program intact during packaging.
    if [[ -d "$work/build" ]]; then
        [[ $(realpath "$work/build") == "$work/build" && ! -L "$work/build" ]] || exit 2
        app="$work/build"
    fi
    (cd "$app"; sha256sum --check --status "$work/source.sha256") || {
        echo 'Development source does not match the Windows workspace.' >&2; exit 1;
    }
    mkdir "$work/payload"
    for component in frontend configd logd sysinfo; do
        mkdir "$work/payload/$component"
        cp -a "$app/$component/dist" "$app/$component/package.json" "$work/payload/$component/"
    done
    mkdir -p "$work/payload/configd/node_modules" "$work/payload/deploy/debian" "$work/payload/release"
    cp "$app/release/package.mjs" "$work/payload/release/"
    cp -a "$app/configd/node_modules/yaml" "$work/payload/configd/node_modules/"
    for file in access-deployment.mjs health.mjs start-core.sh startup-config.mjs core-control.sh core-install.mjs nginx.conf zz-mihomo-manager-tun.conf mihomo-manager.target mihomo-manager-core-control.socket mihomo-manager-core-control@.service mihomo-manager-core.service mihomo-manager-configd.service mihomo-manager-logd.service mihomo-manager-sysinfo.service mihomo-manager-web.service; do
        cp -a "$app/deploy/debian/$file" "$work/payload/deploy/debian/"
    done
    cp "$work/runtime-artifact.sh" "$work/payload/deploy/debian/"
    for file in webui-deployment.mjs webui-install.mjs webui-control.sh mihomo-manager-webui-update.socket mihomo-manager-webui-update@.service mihomo-manager-webui-recover.service; do
        cp "$app/deploy/debian/$file" "$work/payload/deploy/debian/"
    done
    cp "$work/source.sha256" "$work/payload/SOURCE_FILES_SHA256"
    if [[ ! -f "$work/source-metadata.json" ]]; then
        cp "$app/DEPLOYED_REVISION" "$app/DEPLOYED_ARCHIVE_SHA256" "$work/payload/"
    fi
    node "$app/release/runtime.mjs" "$app" "$work/payload" "$work"
    (cd "$work/payload"; find . -type f ! -name RUNTIME_FILES_SHA256 -print0 | sort -z | xargs -0 sha256sum >RUNTIME_FILES_SHA256)
    tar --format=ustar -czf "$work/runtime.tar.gz" -C "$work/payload" .
    artifact=$(cat "$work/artifact-name.txt")
    cp "$work/runtime.tar.gz" "$work/$artifact"
    (cd "$work"; sha256sum "$artifact" >SHA256SUMS)
    cat "$work/SHA256SUMS"
    exit 0
fi

[[ -f "$settings/runtime-only" ]] || { echo 'Target must remain runtime-only.' >&2; exit 2; }
if [[ ${MIHOMO_PVE_LOCKS:-} == 1 ]]; then
    [[ $(readlink /proc/$$/fd/8) == /run/lock/mihomo-manager-core-control.lock ]] || exit 2
else
    exec 8>/run/lock/mihomo-manager-core-control.lock
fi
flock -n 8 || { echo 'A Core operation is running.' >&2; exit 1; }
if [[ "$mode" == rollback ]]; then
    [[ "$work" =~ ^/root/mihomo-runtime-backup-[A-Za-z0-9]+$ && -d "$work/app" && -f "$work/deployment.tar.gz" && ! -e "$work/replaced-app" ]] || exit 2
    access_deployment="$work/access-deployment.mjs"
    access_directory=$(node "$access_deployment" directory "$settings/manager.env")
    node "$access_deployment" compatible "$access_directory" "$work/app"
    node "$access_deployment" prepare "$access_directory"
    systemctl stop mihomo-manager.target
    find "$access_directory" -type f -print0 | sort -z | xargs -0 -r sha256sum >"$work/access-rollback.sha256"
    mv "$app" "$work/replaced-app"
    cp -a "$work/app" "$app"
    tar -xzf "$work/deployment.tar.gz" -C /
    node "$access_deployment" permissions "$access_directory" "$access_permissions"
    systemctl daemon-reload
    systemctl restart mihomo-manager.target
    health
    if [[ -s "$work/access-rollback.sha256" ]]; then sha256sum --check --status "$work/access-rollback.sha256"; fi
    echo 'Program rollback complete; runtime data and Core were preserved.'
    exit 0
fi

[[ "$mode" == install && "$work" =~ ^/tmp/mihomo-runtime-[a-f0-9]{32}$ ]] || exit 2
mkdir "$work/payload"
tar -xzf "$work/runtime.tar.gz" -C "$work/payload"
(cd "$work/payload"; sha256sum --check --status RUNTIME_FILES_SHA256)
access_deployment="$work/access-deployment.mjs"
cp "$work/payload/deploy/debian/access-deployment.mjs" "$access_deployment"
access_directory=$(node "$access_deployment" directory "$settings/manager.env")
node "$access_deployment" compatible "$access_directory" "$work/payload"
node --input-type=module - "$work/payload" "$settings/manager.env" "$work/nginx.conf" <<'JS'
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {isIP} from 'node:net';
const [app, environment, output] = process.argv.slice(2);
const build = JSON.parse(fs.readFileSync(`${app}/RUNTIME_BUILD.json`, 'utf8'));
if (build.node !== process.version || build.arch !== process.arch || build.platform !== process.platform) throw new Error('Runtime does not match the build environment');
createRequire(`${app}/configd/package.json`)('yaml').parse('runtime: true');
const lines = fs.readFileSync(environment, 'utf8').split(/\r?\n/);
const value = name => lines.findLast(line => line.trimStart().startsWith(`${name}=`))?.trim().slice(name.length + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
const host = value('SYSINFO_HOST'), port = Number(value('SYSINFO_PORT'));
if (!isIP(host ?? '') || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid sysinfo listen configuration');
fs.writeFileSync(output, fs.readFileSync(`${app}/deploy/debian/nginx.conf`, 'utf8').replaceAll('__SYSINFO_UPSTREAM__', `${isIP(host) === 6 ? `[${host}]` : host}:${port}`));
JS
backup=$(mktemp -d /root/mihomo-runtime-backup-XXXXXXXX)
chmod 700 "$backup"
cp "$work/runtime-artifact.sh" "$backup/restore.sh"
cp "$access_deployment" "$backup/access-deployment.mjs"
cp "$work/payload/deploy/debian/health.mjs" "$work/health.mjs"
cp "$work/health.mjs" "$backup/health.mjs"
config_files=(etc/mihomo-manager/nginx.conf usr/local/libexec/mihomo-manager-core-control usr/local/libexec/mihomo-manager-core-install.mjs etc/tmpfiles.d/zz-mihomo-manager-tun.conf)
for file in /etc/systemd/system/mihomo-manager*.service /etc/systemd/system/mihomo-manager*.socket /etc/systemd/system/mihomo-manager.target; do config_files+=("${file#/}"); done
if [[ -f "$access_permissions" ]]; then config_files+=("${access_permissions#/}"); fi
for file in /usr/local/libexec/mihomo-manager-webui /usr/local/libexec/mihomo-manager-webui-control /etc/systemd/system/mihomo-manager-sysinfo.service.d/30-webui-update.conf; do
    if [[ -e "$file" ]]; then config_files+=("${file#/}"); fi
done
tar -czf "$backup/deployment.tar.gz" -C / "${config_files[@]}"
cp -a "$settings/manager.env" "$backup/manager.env.before"
systemctl show mihomo-manager-{core,configd,logd,sysinfo,web}.service -p Id -p ActiveState >"$backup/services.before.txt"
printf 'RUNTIME_BACKUP=%s\n' "$backup"
node "$access_deployment" prepare "$access_directory"
systemctl stop mihomo-manager.target
# Keep all user configuration, metadata, Core and Node outside the program swap.
find /var/lib/mihomo-manager/configs /var/lib/mihomo-manager/providers /var/lib/mihomo-manager/ruleset /var/lib/mihomo-manager/generated-runtime -type f -print0 >"$backup/preserved.paths"
find /var/lib/mihomo-manager -maxdepth 1 -type f \( -name '*.json' -o -name '*.yaml' \) -print0 >>"$backup/preserved.paths"
printf '%s\0' "$settings/manager.env" "$settings/runtime-only" /opt/mihomo-manager/node/bin/node /opt/mihomo-manager/bin/mihomo >>"$backup/preserved.paths"
[[ ! -f /opt/mihomo-manager/bin/mihomo.previous ]] || printf '%s\0' /opt/mihomo-manager/bin/mihomo.previous >>"$backup/preserved.paths"
find "$access_directory" -type f -print0 >>"$backup/preserved.paths"
sort -zu "$backup/preserved.paths" | xargs -0 sha256sum >"$backup/preserved.sha256"
mv "$app" "$backup/app"
mv "$work/payload" "$app"
chmod 755 "$app"
install -m 644 "$work/nginx.conf" "$settings/nginx.conf"
install -o root -g root -m 755 "$app/deploy/debian/core-control.sh" /usr/local/libexec/mihomo-manager-core-control
install -o root -g root -m 644 "$app/deploy/debian/core-install.mjs" /usr/local/libexec/mihomo-manager-core-install.mjs
for unit in "$app"/deploy/debian/mihomo-manager*.service "$app"/deploy/debian/mihomo-manager*.socket "$app"/deploy/debian/mihomo-manager.target; do install -m 644 "$unit" /etc/systemd/system/; done
node "$access_deployment" permissions "$access_directory" "$access_permissions"
node "$app/deploy/debian/webui-deployment.mjs" "$app"
install -m 644 "$app/deploy/debian/zz-mihomo-manager-tun.conf" /etc/tmpfiles.d/zz-mihomo-manager-tun.conf
systemd-tmpfiles --create /etc/tmpfiles.d/zz-mihomo-manager-tun.conf
systemctl daemon-reload
systemctl enable mihomo-manager.target >/dev/null
systemctl restart mihomo-manager.target
health
sha256sum --check --status "$backup/preserved.sha256" || { echo 'Preserved files changed; review the private backup manifest.' >&2; exit 1; }
echo 'Runtime deployment ready; preserved file hashes match.'
