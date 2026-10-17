#!/bin/bash
set -euo pipefail
export PATH=/opt/mihomo-manager/node/bin:/usr/sbin:/usr/bin:/sbin:/bin
[[ $EUID == 0 && -f /etc/mihomo-manager/deployment-owned && -f /etc/mihomo-manager/runtime-only ]] || exit 2
exec 9>/run/lock/mihomo-manager-deploy.lock
exec 8>/run/lock/mihomo-manager-core-control.lock
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }
flock -n 8 || { echo 'A Core operation is running.' >&2; exit 1; }
export MIHOMO_PVE_LOCKS=1
app=/opt/mihomo-manager/app
node=/opt/mihomo-manager/node

if [[ ${1:-} == rollback ]]; then
    backup=$(realpath "${2:?backup required}")
    [[ $backup =~ ^/root/mihomo-runtime-backup-[A-Za-z0-9]+$ && -f $backup/pve-environment.json && -d $backup/node.before && -d $backup/app ]] || exit 2
    [[ ! -e $backup/replaced-app && ! -L $backup/replaced-app && ! -e $backup/node.replaced && ! -L $backup/node.replaced ]] || exit 2
    [[ -f $backup/deployment.tar.gz && -f $backup/restore.sh && -f $backup/access-deployment.mjs && -f $backup/health.mjs && -x $backup/node.before/bin/node ]] || exit 2
    [[ $(realpath "$app") == "$app" && ! -L $app && -d $node && ! -L $node ]] || exit 2
    bash -n "$backup/restore.sh"
    access_directory=$("$backup/node.before/bin/node" "$backup/access-deployment.mjs" directory /etc/mihomo-manager/manager.env)
    "$backup/node.before/bin/node" "$backup/access-deployment.mjs" compatible "$access_directory" "$backup/app"
    stage=$(mktemp -d /root/mihomo-environment-rollback.XXXXXXXX)
    changed=0
    finish_rollback() {
        result=$?
        trap - EXIT
        restored=1
        if ((result != 0 && changed)); then
            set +e
            systemctl stop mihomo-manager.target || restored=0
            if [[ -d $backup/node.replaced ]]; then
                { rm -rf -- "$node" && mv "$backup/node.replaced" "$node"; } || restored=0
            fi
            if [[ -d $backup/replaced-app ]]; then
                { rm -rf -- "$app" && mv "$backup/replaced-app" "$app"; } || restored=0
            fi
            tar -xzf "$stage/deployment.current.tar.gz" -C / || restored=0
            systemctl daemon-reload || restored=0
            if ((restored)); then
                systemctl restart mihomo-manager.target || restored=0
                "$node/bin/node" "$app/deploy/debian/health.mjs" || restored=0
                systemctl is-active mihomo-manager-{core,configd,logd,sysinfo,web}.service || restored=0
            fi
            if ((restored)); then
                echo 'Rollback failed; the previous environment and services were restored.' >&2
            else
                echo "Rollback recovery needs review: $stage" >&2
            fi
        fi
        if ((restored)); then rm -rf -- "$stage"; fi
        return "$result"
    }
    trap finish_rollback EXIT
    tar -tzf "$backup/deployment.tar.gz" >"$stage/deployment.paths"
    tar -czf "$stage/deployment.current.tar.gz" -C / --verbatim-files-from -T "$stage/deployment.paths"
    changed=1
    systemctl stop mihomo-manager.target
    mv "$node" "$backup/node.replaced"
    cp -a "$backup/node.before" "$node"
    bash "$backup/restore.sh" rollback "$backup"
    echo 'Environment rollback complete.'
    exit 0
fi

bundle=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ ${1:-} == install && -f $bundle/environment.json && -x $bundle/node/bin/node ]] || exit 2
[[ $(. /etc/os-release; printf '%s:%s' "$ID" "$VERSION_ID") == debian:12 && $(uname -m) == x86_64 ]] || exit 2
stage=$(mktemp -d /tmp/mihomo-runtime-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX)
# mktemp's alphabet is normalized for the existing deployment entry point.
normalized=/tmp/mihomo-runtime-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
mv "$stage" "$normalized"; stage=$normalized
chmod 700 "$stage"
backup=; changed=0; succeeded=0
finish() {
    result=$?
    if ((changed && !succeeded)); then
        systemctl stop mihomo-manager.target || true
        if [[ -d $stage/node.before ]]; then
            rm -rf -- "$node"
            mv "$stage/node.before" "$node"
        fi
        if [[ -n $backup && -d $backup/app ]]; then
            if ! bash "$backup/restore.sh" rollback "$backup"; then
                echo "Recovery needs review: $backup" >&2
                return
            fi
        else
            systemctl restart mihomo-manager.target || true
        fi
    fi
    if ((succeeded)) || (( !changed )); then rm -rf -- "$stage"; fi
    return "$result"
}
trap finish EXIT
candidate_version=$("$bundle/node/bin/node" -p 'process.version')
"$node/bin/node" --input-type=module - "$bundle" "$stage" "$candidate_version" <<'JS'
import {readFileSync} from 'node:fs';
import {validateRuntimePackage} from '/opt/mihomo-manager/app/release/package.mjs';
const [bundle,stage,node]=process.argv.slice(2);
const manifest=JSON.parse(readFileSync(bundle+'/environment.json','utf8'));
if(manifest.schemaVersion!==1||manifest.product!=='mihomo-manager'||manifest.node!==node) throw new Error('Invalid environment manifest');
const currentVersion=JSON.parse(readFileSync('/opt/mihomo-manager/app/frontend/package.json','utf8')).version;
const versions=[currentVersion,manifest.managerVersion];
if(versions.some(value=>typeof value!=='string'||!/^\d+\.\d+\.\d+$/.test(value))) throw new Error('Cannot confirm manager versions');
const [current,target]=versions.map(value=>value.split('.').map(Number));
const different=target.findIndex((part,index)=>part!==current[index]);
if(different!==-1&&target[different]<current[different]) throw new Error('Environment package would downgrade the installed manager');
await validateRuntimePackage(bundle+'/runtime.tar.gz',stage+'/validated',{expectedSha256:manifest.runtimeSha256,expectedVersion:manifest.managerVersion,node});
JS
cp "$bundle/runtime.tar.gz" "$stage/runtime.tar.gz"
cp "$bundle/runtime-artifact.sh" "$stage/runtime-artifact.sh"
cp -a "$node" "$stage/node.before"
systemctl stop mihomo-manager.target
changed=1
rm -rf -- "$node"
cp -a "$bundle/node" "$node"
chmod -R a+rX "$node"
if bash "$stage/runtime-artifact.sh" install "$stage" >"$stage/install.log" 2>&1; then
    backup=$(sed -n 's/^RUNTIME_BACKUP=//p' "$stage/install.log" | tail -n 1)
    [[ $backup =~ ^/root/mihomo-runtime-backup-[A-Za-z0-9]+$ && -d $backup/app ]] || exit 1
    mv "$stage/node.before" "$backup/node.before"
    cp "$bundle/environment.json" "$backup/pve-environment.json"
    cp "$bundle/environment-update.sh" "$backup/environment-update.sh"
    succeeded=1
    for previous in /root/mihomo-runtime-backup-*; do
        [[ $previous == "$backup" || ! -f $previous/pve-environment.json ]] && continue
        [[ ! -L $previous && $(realpath "$previous") == "$previous" ]] || continue
        rm -rf -- "$previous"
    done
    echo 'Environment update complete; health and preserved data checks passed.'
    printf 'ENVIRONMENT_BACKUP=%s\n' "$backup"
    printf 'Rollback: bash %s/environment-update.sh rollback %s\n' "$backup" "$backup"
else
    result=$?
    backup=$(sed -n 's/^RUNTIME_BACKUP=//p' "$stage/install.log" | tail -n 1)
    [[ -z $backup || $backup =~ ^/root/mihomo-runtime-backup-[A-Za-z0-9]+$ ]] || backup=
    echo "Environment update failed; restoring the previous environment. Private log: $stage/install.log" >&2
    exit "$result"
fi
