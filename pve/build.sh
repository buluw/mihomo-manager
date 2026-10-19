#!/bin/bash
set -euo pipefail
export LC_ALL=C.UTF-8
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ $EUID == 0 && -d /etc/pve ]] || { echo 'Run on a PVE host as root.' >&2; exit 2; }
mode=${1:?prepare or pack required}
if [[ $mode == prepare ]]; then
    backup=$(realpath "${2:?backup required}")
    sha=${3:?SHA256 required}; id=${4:?build CT ID required}; storage=${5:?storage required}
    [[ $id =~ ^[1-9][0-9]{2,8}$ && $sha =~ ^[a-f0-9]{64}$ && $storage =~ ^[A-Za-z0-9_-]+$ ]] || exit 2
    [[ ! -e /etc/pve/lxc/$id.conf && ! -e /etc/pve/qemu-server/$id.conf ]] || exit 2
    printf '%s  %s\n' "$sha" "$backup" | sha256sum -c - >/dev/null
    pct restore "$id" "$backup" --storage "$storage" --rootfs "$storage:4" --hostname mihomo-template-build --unprivileged 1 --cores 1 --memory 1024 --swap 256 --onboot 0 --net0 name=eth0,ip=manual,link_down=1 --net1 name=eth1,ip=manual,link_down=1 --description mihomo-pve-build
    echo "Build copy $id is stopped and disconnected."
elif [[ $mode == pack ]]; then
    id=${2:?build CT ID required}; out=$(realpath "${3:?private output directory required}")
    runtime=$(realpath "${4:?runtime package required}"); sha=${5:?runtime SHA256 required}
    geo=$(realpath "${6:?staged public GEO directory required}")
    [[ $id =~ ^[1-9][0-9]{2,8}$ && $out != / && $sha =~ ^[a-f0-9]{64}$ ]] || exit 2
    [[ $(pct status "$id") == 'status: stopped' ]] || exit 2
    pct config "$id" | grep -q '^description: mihomo-pve-build' || exit 2
    root=/var/lib/lxc/$id/rootfs
    if ! mountpoint -q "$root"; then pct mount "$id"; fi
    part=
    trap '[[ -z "$part" ]] || rm -f -- "$part"; pct unmount "$id" >/dev/null 2>&1 || true' EXIT
    python3 "$here/sanitize.py" "$root" "$here" "$runtime" "$sha" "$geo" >"$out/template-build.json"
    version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["managerVersion"])' "$out/template-build.json")
    artifact="mihomo-manager-pve-debian12-amd64-v${version}-candidate.tar.zst"
    [[ ! -e "$out/$artifact" ]] || { echo 'Output already exists.' >&2; exit 2; }
    part="$out/$artifact.part"
    [[ ! -e "$part" ]] || exit 2
    lxc-usernsexec -m u:0:100000:65536 -m g:0:100000:65536 -- tar --numeric-owner --one-file-system --acls --xattrs --exclude=./lost+found -C "$root" -cpf - . | zstd -T1 -3 -q -o "$part"
    zstd -tq "$part"
    mv -- "$part" "$out/$artifact"
    part=
    (cd "$out"; sha256sum "$artifact")
elif [[ $mode == environment ]]; then
    id=${2:?build CT ID required}; out=$(realpath "${3:?private output directory required}")
    runtime=$(realpath "${4:?runtime package required}"); sha=${5:?runtime SHA256 required}
    [[ $id =~ ^[1-9][0-9]{2,8}$ && $sha =~ ^[a-f0-9]{64}$ && $(pct status "$id") == 'status: stopped' ]] || exit 2
    pct config "$id" | grep -q '^description: mihomo-pve-build' || exit 2
    printf '%s  %s\n' "$sha" "$runtime" | sha256sum -c - >/dev/null
    root=/var/lib/lxc/$id/rootfs
    if ! mountpoint -q "$root"; then pct mount "$id"; fi
    work=$(mktemp -d "$out/environment.XXXXXXXX")
    trap 'rm -rf -- "$work"; pct unmount "$id" >/dev/null 2>&1 || true' EXIT
    [[ -f $root/etc/mihomo-manager/pve-template.json ]] || exit 2
    mkdir -p "$work/node/bin"
    install -m 755 "$root/opt/mihomo-manager/node/bin/node" "$work/node/bin/node"
    install -m 644 "$root/opt/mihomo-manager/node/LICENSE" "$work/node/LICENSE"
    cp "$runtime" "$work/runtime.tar.gz"
    cp "$here/environment-update.sh" "$work/"
    cp "$here/../deploy/debian/runtime-artifact.sh" "$work/"
    python3 - "$root/etc/mihomo-manager/pve-template.json" "$work" <<'PY'
import hashlib,json,pathlib,sys
record=json.load(open(sys.argv[1])); work=pathlib.Path(sys.argv[2])
record={key:record[key] for key in ('schemaVersion','product','managerVersion','node','runtimeSha256')}
record['sourceFiles']={name:hashlib.sha256((work/name).read_bytes()).hexdigest() for name in ('environment-update.sh','runtime-artifact.sh')}
(work/'environment.json').write_text(json.dumps(record,indent=2)+'\n')
PY
    version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["managerVersion"])' "$work/environment.json")
    artifact="mihomo-manager-pve-environment-v${version}-candidate.tar.gz"
    [[ ! -e "$out/$artifact" ]] || exit 2
    tar --owner=0 --group=0 --numeric-owner -czf "$out/$artifact.part" -C "$work" .
    mv "$out/$artifact.part" "$out/$artifact"
    (cd "$out"; sha256sum "$artifact")
else
    echo 'Expected prepare, pack or environment.' >&2; exit 2
fi
