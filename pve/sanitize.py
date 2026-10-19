#!/usr/bin/env python3
"""Prepare a stopped, mounted build copy for distribution."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile


# MetaCubeX public release snapshot, published 2026-10-18. Stage these inputs
# separately from the CT backup; installation consumes the bundled copies.
PUBLIC_GEO = {
    'geoip.metadb': {
        'source': 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.metadb',
        'sha256': 'ec6701e428b7efe610fe40b187a69fb03324892a56792b033adc080d2b6c273e',
        'bytes': 8423041,
    },
    'GeoSite.dat': {
        'source': 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat',
        'sha256': '9cdf0d2f5cfab1f8a08c79503c92b1d712d1b6bb78c8567b55a0847f5a513cb7',
        'bytes': 4272747,
    },
}


def read_public_geo(folder):
    files = {}
    for name, record in PUBLIC_GEO.items():
        path = Path(folder) / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size != record['bytes']:
            raise ValueError('Missing or invalid public GEO input: ' + name)
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != record['sha256']:
            raise ValueError('Public GEO checksum mismatch: ' + name)
        files[name] = data
    return files


def prepare(root, assets, runtime, expected, geo):
    root, assets, runtime = Path(root), Path(assets), Path(runtime)
    if os.geteuid() != 0 or root.resolve() != root or root.parts[:4] != ('/', 'var', 'lib', 'lxc') or root.name != 'rootfs':
        raise ValueError('Expected an explicit mounted build container')
    if not (root / 'etc/mihomo-manager/deployment-owned').is_file():
        raise ValueError('Expected a managed container')
    offset = (root / 'etc').stat().st_uid
    if offset != 100000:
        raise ValueError('Only the standard unprivileged mapping is supported')
    users = [line.split(':') for line in (root / 'etc/passwd').read_text().splitlines()]
    account = next(value for value in users if value[0] == 'mihomo-manager')
    uid, gid = int(account[2]), int(account[3])
    if any(1000 <= int(value[2]) < 65534 for value in users):
        raise ValueError('Review additional user accounts before building')
    if hashlib.sha256(runtime.read_bytes()).hexdigest() != expected:
        raise ValueError('Runtime package checksum mismatch')
    if Path(geo).resolve().is_relative_to(root):
        raise ValueError('Public GEO inputs must be staged outside the build container')
    geo_files = read_public_geo(geo)

    def target(relative):
        value = root / relative
        if not value.parent.resolve().is_relative_to(root):
            raise ValueError('Path escapes mounted root')
        return value

    def remove(relative):
        path = target(relative)
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.exists():
            shutil.rmtree(path)

    def directory(relative, mode=0o755, owner=0, group=0):
        path = target(relative)
        if path.is_symlink():
            raise ValueError('Directory must not be a symbolic link')
        missing = []
        parent = path
        while not parent.exists():
            missing.append(parent)
            parent = parent.parent
        for parent in reversed(missing):
            parent.mkdir(mode=0o755)
            os.chown(parent, offset, offset)
        os.chmod(path, mode)
        os.chown(path, offset + owner, offset + group)

    def write(relative, data, mode=0o644, owner=0, group=0):
        path = target(relative)
        directory(str(Path(relative).parent))
        if path.is_symlink():
            path.unlink()
        path.write_bytes(data.encode() if isinstance(data, str) else data)
        os.chmod(path, mode)
        os.chown(path, offset + owner, offset + group)

    remove('opt/mihomo-manager/app')
    directory('opt/mihomo-manager/app')
    with tarfile.open(runtime, 'r:gz') as archive:
        for item in archive:
            name = item.name.removeprefix('./').rstrip('/')
            if not name:
                continue
            if name.startswith('/') or '..' in Path(name).parts or not (item.isfile() or item.isdir()):
                raise ValueError('Unsupported runtime archive entry')
            destination = 'opt/mihomo-manager/app/' + name
            if item.isdir():
                directory(destination)
            else:
                write(destination, archive.extractfile(item).read())
    app = root / 'opt/mihomo-manager/app'
    for line in (app / 'RUNTIME_FILES_SHA256').read_text().splitlines():
        digest, name = line.split('  ', 1)
        path = (app / name).resolve()
        if not path.is_relative_to(app) or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError('Runtime file verification failed')
    build = json.loads((app / 'RUNTIME_BUILD.json').read_text())
    for name in ('root', 'home', 'tmp', 'var/tmp', 'run', 'var/log', 'var/backups',
                 'var/lib/mihomo-manager', 'var/lib/mihomo-manager-webui-install',
                 'var/lib/dhcp', 'var/lib/systemd/coredump', 'var/lib/systemd/timers',
                 'var/cache/apt/archives', 'var/lib/apt/lists', 'etc/vzdump',
                 'etc/mihomo-manager', 'etc/ssh/sshd_config.d',
                 'etc/network/interfaces.d', 'etc/apt/auth.conf.d',
                 'usr/local/share/ca-certificates'):
        remove(name)
        directory(name, 0o700 if name == 'root' else 0o755)
    for name in ('etc/shadow-', 'etc/gshadow-', 'etc/passwd-', 'etc/group-',
                 'etc/apt/auth.conf', 'etc/machine-info', 'var/lib/systemd/random-seed',
                 'etc/ssl/private/ssl-cert-snakeoil.key', 'etc/ssl/certs/ssl-cert-snakeoil.pem'):
        remove(name)
    for name in ('var/spool/cron/crontabs', 'var/mail'):
        remove(name)
        directory(name)
    for path in (root / 'etc/ssh').glob('ssh_host_*'):
        remove(str(path.relative_to(root)))
    for path in (root / 'opt/mihomo-manager').iterdir():
        if path.name not in ('app', 'node', 'bin'):
            remove(str(path.relative_to(root)))
    for path in (root / 'opt/mihomo-manager/bin').iterdir():
        if path.name != 'mihomo':
            remove(str(path.relative_to(root)))
    for name in ('.profile', '.bashrc'):
        source = root / 'etc/skel' / name
        if source.is_file():
            write('root/' + name, source.read_bytes())
    shadow_gid = (root / 'etc/shadow').stat().st_gid - offset
    shadow = []
    for line in (root / 'etc/shadow').read_text().splitlines():
        fields = line.split(':')
        fields[1] = '!'
        shadow.append(':'.join(fields))
    write('etc/shadow', '\n'.join(shadow) + '\n', 0o640, 0, shadow_gid)
    groups = []
    for line in (root / 'etc/gshadow').read_text().splitlines():
        fields = line.split(':')
        fields[1] = '!'
        groups.append(':'.join(fields))
    write('etc/gshadow', '\n'.join(groups) + '\n', 0o640, 0, shadow_gid)
    for path in (root / 'etc').glob('.pve-ignore.*'):
        remove(str(path.relative_to(root)))
    for path in root.rglob('authorized_keys'):
        if path.is_file():
            path.unlink()
    write('etc/machine-id', '')
    remove('var/lib/dbus/machine-id')
    directory('var/lib/dbus')
    os.symlink('/etc/machine-id', root / 'var/lib/dbus/machine-id')
    os.lchown(root / 'var/lib/dbus/machine-id', offset, offset)
    write('etc/hostname', 'mihomo\n')
    write('etc/hosts', '127.0.0.1 localhost\n127.0.1.1 mihomo\n::1 localhost ip6-localhost ip6-loopback\n')
    write('etc/resolv.conf', '')
    write('etc/network/interfaces', 'auto lo\niface lo inet loopback\n')
    write('etc/sysctl.d/90-mihomo-forward.conf', 'net.ipv4.ip_forward=1\n')
    for name in ('tmp', 'var/tmp'):
        os.chmod(root / name, 0o1777)
    source = assets.parent / 'deploy/debian'
    environment = (source / 'manager.env.example').read_text().replace('configs/debian-development.yaml', 'configs/main.yaml')
    write('etc/mihomo-manager/manager.env', environment, 0o640, 0, gid)
    for name in ('deployment-owned', 'runtime-only', 'pve-template'):
        write('etc/mihomo-manager/' + name, '')
    for name in ('', '/configs', '/providers', '/ruleset', '/generated-runtime', '/logs', '/core-update', '/access', '/webui-update'):
        directory('var/lib/mihomo-manager' + name, 0o700, uid, gid)
    bootstrap = (source / 'test/development.yaml').read_bytes()
    write('var/lib/mihomo-manager/bootstrap.yaml', bootstrap, 0o640, 0, gid)
    write('var/lib/mihomo-manager/configs/main.yaml', bootstrap, 0o600, uid, gid)
    for name, data in geo_files.items():
        write('var/lib/mihomo-manager/' + name, data, 0o600, uid, gid)
    directory('var/lib/mihomo-manager', 0o700, uid, gid)
    directory('var/lib/mihomo-manager/configs', 0o700, uid, gid)
    nginx = (app / 'deploy/debian/nginx.conf').read_text().replace('__SYSINFO_UPSTREAM__', '127.0.0.1:9083')
    write('etc/mihomo-manager/nginx.conf', nginx)
    for path in (app / 'deploy/debian').glob('mihomo-manager*'):
        if path.suffix in ('.service', '.socket', '.target'):
            write('etc/systemd/system/' + path.name, path.read_bytes())
    remove('etc/systemd/system/mihomo-manager-sysinfo.service.d')
    directory('etc/systemd/system/mihomo-manager-sysinfo.service.d')
    write('usr/local/libexec/mihomo-manager-firstboot', (assets / 'firstboot.sh').read_bytes(), 0o755)
    write('etc/systemd/system/mihomo-manager-firstboot.service', (assets / 'firstboot.service').read_bytes())
    write('etc/systemd/system/mihomo-manager.target.d/10-firstboot.conf', '[Unit]\nRequires=mihomo-manager-firstboot.service\nAfter=mihomo-manager-firstboot.service\n')
    directory('etc/systemd/system/multi-user.target.wants')
    link = root / 'etc/systemd/system/multi-user.target.wants/mihomo-manager-firstboot.service'
    if link.is_symlink():
        link.unlink()
    os.symlink('../mihomo-manager-firstboot.service', link)
    os.lchown(link, offset, offset)
    for path in (root / 'var/lib/mihomo-manager').rglob('*'):
        if path.is_dir():
            os.chmod(path, 0o700)
            os.chown(path, offset + uid, offset + gid)
    report = {'schemaVersion': 1, 'product': 'mihomo-manager', 'managerVersion': json.loads((app / 'frontend/package.json').read_text())['version'],
              'runtimeSha256': expected, 'source': build['source'], 'node': build['node'], 'architecture': 'amd64',
              'serviceUid': uid, 'serviceGid': gid, 'coreSha256': hashlib.sha256((root / 'opt/mihomo-manager/bin/mihomo').read_bytes()).hexdigest(),
              'publicGeo': {name: {**record, 'path': '/var/lib/mihomo-manager/' + name, 'uid': uid, 'gid': gid, 'mode': '0600'}
                            for name, record in PUBLIC_GEO.items()}}
    write('etc/mihomo-manager/pve-template.json', json.dumps(report, indent=2) + '\n')
    return report


if __name__ == '__main__':
    if len(sys.argv) != 6:
        sys.exit('Usage: sanitize.py ROOT ASSETS RUNTIME SHA256 GEO_DIR')
    print(json.dumps(prepare(*sys.argv[1:]), ensure_ascii=False))
