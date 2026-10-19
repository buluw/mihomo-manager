#!/usr/bin/env python3
"""PVE host menu. Container configuration and data stay in their existing layout."""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import uuid

INDEX = 'https://raw.githubusercontent.com/buluw/mihomo-manager/main/pve/template.json'
RELEASE = 'https://github.com/buluw/mihomo-manager/releases/download/'
APP = '/opt/mihomo-manager/app'
NODE = '/opt/mihomo-manager/node/bin/node'


def run(*args, capture=False):
    return subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE if capture else None).stdout


def heading(title):
    print('\n  MIHOMO MANAGER\n  ' + '-' * 64 + '\n\n  ' + title + '\n', flush=True)


def prompt(label, default='', required=False):
    hint = '[必填]' if required and not default else f'[回车默认 {default or "稍后配置"}]'
    value = input(f'  {label} {hint}: ').strip()
    return value or str(default)


def valid_id(value):
    if not re.fullmatch(r'[1-9][0-9]{2,8}', value):
        raise ValueError('容器编号必须是 100 及以上的数字。')
    return value


def number(value, minimum, maximum):
    if not value.isdigit() or not minimum <= int(value) <= maximum:
        raise ValueError(f'请输入 {minimum}–{maximum} 范围内的整数。')
    return value


def ipv4(value):
    address = ipaddress.IPv4Address(value)
    if address.is_multicast or address.is_loopback or address.is_unspecified or int(address) % 256 in (0, 255):
        raise ValueError('请输入可用的 IPv4 主机地址。')
    return str(address)


def select_bridge(bridges, label, selected):
    print('  ' + label)
    for index, bridge in enumerate(bridges, 1):
        details = [bridge['iface'], bridge['type'], '已启用']
        address = bridge.get('cidr') or bridge.get('address')
        if address:
            details.append('宿主地址 ' + str(address))
        if bridge.get('gateway'):
            details.append('网关 ' + str(bridge['gateway']))
        ports = bridge.get('bridge_ports') or bridge.get('ovs_ports')
        if ports:
            details.append('端口 ' + str(ports))
        if bridge.get('comments'):
            details.append('备注 ' + ' '.join(str(bridge['comments']).split()))
        print(f'    [{index}] ' + ' / '.join(details))
    default = next(str(index) for index, bridge in enumerate(bridges, 1) if bridge['iface'] == selected)
    while True:
        choice = prompt('网桥编号', default)
        try:
            number(choice, 1, len(bridges))
            return bridges[int(choice) - 1]['iface']
        except ValueError as error:
            print('  ' + str(error))


def fetch(url, path, maximum):
    run('curl', '-fsSL', '--proto', '=https', '--proto-redir', '=https', '--retry', '2', '--connect-timeout', '15',
        '--max-time', '600', '--max-filesize', str(maximum), url, '-o', str(path))


def manifest(local, work):
    if local:
        path = Path(local).resolve(strict=True)
        if not path.is_file() or path.stat().st_uid != 0 or path.stat().st_mode & 0o022:
            raise ValueError('本地候选清单必须由 root 持有且其他账号不可写。')
    else:
        path = work / 'template.json'
        fetch(INDEX, path, 65536)
    if path.stat().st_size > 65536:
        raise ValueError('发布清单过大。')
    data = json.loads(path.read_text())
    if data.get('schemaVersion') != 1 or data.get('product') != 'mihomo-manager':
        raise ValueError('发布清单格式不支持。')
    if data.get('status') != 'released' and not (local and data.get('status') == 'candidate'):
        raise ValueError('PVE 发布包正在等待审核；正式发布后即可使用。')
    return data, path.parent if local else None


def asset(record, folder, name, local_root):
    if not isinstance(record, dict) or not re.fullmatch(r'[a-f0-9]{64}', record.get('sha256', '')):
        raise ValueError('发布附件信息不完整。')
    size = record.get('bytes')
    if not isinstance(size, int) or not 0 < size <= 2 * 1024**3:
        raise ValueError('发布附件大小无效。')
    destination = folder / name
    if local_root and record.get('file'):
        source = (local_root / record['file']).resolve(strict=True)
        if not source.is_relative_to(local_root) or not source.is_file():
            raise ValueError('候选附件不在清单目录内。')
        shutil.copyfile(source, destination)
    else:
        url = record.get('url', '')
        if not url.startswith(RELEASE) or '?' in url or '#' in url:
            raise ValueError('附件必须来自项目的 GitHub Release。')
        fetch(url, destination, size)
    with destination.open('rb') as handle:
        digest = hashlib.file_digest(handle, 'sha256').hexdigest()
    if destination.stat().st_size != size or digest != record['sha256']:
        raise ValueError('附件大小或 SHA256 校验失败，操作已停止。')
    return destination


def management_ip(ctid, wait=0):
    deadline = time.monotonic() + wait
    while True:
        try:
            interfaces = json.loads(run('pct', 'exec', ctid, '--', 'ip', '-j', '-4', 'addr', 'show', 'dev', 'eth0', capture=True))
            for interface in interfaces:
                for address in interface.get('addr_info', []):
                    value = address.get('local', '')
                    if address.get('scope') == 'global' and not ipaddress.ip_address(value).is_link_local:
                        return value
        except (ValueError, subprocess.CalledProcessError):
            pass
        if time.monotonic() >= deadline:
            return None
        time.sleep(1)


def current_version(ctid):
    return run('pct', 'exec', ctid, '--', NODE, '-p', f"require('{APP}/frontend/package.json').version", capture=True).strip()


def info(ctid=None):
    ctid = valid_id(ctid or prompt('容器编号', '120'))
    config = run('pct', 'config', ctid, capture=True)
    state = run('pct', 'status', ctid, capture=True).strip()
    heading('容器信息')
    print(f'  容器编号     {ctid}\n  {state}')
    for line in config.splitlines():
        if line.split(':', 1)[0] in ('hostname', 'cores', 'memory', 'rootfs', 'net0', 'net1'):
            print('  ' + line)
    if state == 'status: running':
        address = management_ip(ctid)
        print('  后台地址     ' + (f'http://{address}:9090' if address else '尚未获得地址，可稍后再次查询'))
        try:
            print('  管理器版本   ' + current_version(ctid))
        except subprocess.CalledProcessError:
            print('  管理器版本   暂时无法读取')
    print(f'\n  PVE 宿主机维护命令：pct enter {ctid}')


def install(local):
    with tempfile.TemporaryDirectory(prefix='mihomo-pve-', dir='/var/tmp') as temporary:
        work = Path(temporary)
        release, local_root = manifest(local, work)
        template = release['template']
        if template.get('architecture') != 'amd64':
            raise ValueError('模板架构不支持。')
        stores = [line.split()[0] for line in run('pvesm', 'status', '--content', 'rootdir', capture=True).splitlines()[1:] if line.split()[2] == 'active']
        node = os.uname().nodename.split('.')[0]
        networks = json.loads(run('pvesh', 'get', f'/nodes/{node}/network', '--output-format', 'json', capture=True))
        bridges = sorted((item for item in networks if item.get('type') in ('bridge', 'OVSBridge') and item.get('active')), key=lambda item: item['iface'])
        if not stores or not bridges:
            raise ValueError('需要可用的容器存储和网桥。')
        bridge_names = [item['iface'] for item in bridges]
        management_bridge = next((item['iface'] for item in bridges if item.get('gateway')), bridge_names[0])
        values = dict(ctid=run('pvesh', 'get', '/cluster/nextid', capture=True).strip().strip('"'), name='mihomo', cores='1', memory='1024', disk='4', storage=stores[0],
                      bridge0=management_bridge, bridge1=next((name for name in bridge_names if name != management_bridge), management_bridge), mode='1', ip='', gateway='', internal='')
        while True:
            heading('安装 / 基本设置')
            for key, label in [('ctid', '容器编号'), ('name', '容器名称'), ('cores', 'CPU 核数'), ('memory', '内存 MiB'), ('disk', '磁盘 GiB')]:
                values[key] = prompt(label, values[key])
            values['storage'] = prompt('存储位置（' + ' / '.join(stores) + '）', values['storage'])
            heading('安装 / 网络设置')
            values['bridge0'] = select_bridge(bridges, '管理网卡 eth0：用于访问后台及默认出口，请选择管理网络所在网桥。', values['bridge0'])
            values['mode'] = prompt('管理地址：1 DHCP / 2 手动静态', values['mode'])
            if values['mode'] == '2':
                values['ip'] = prompt('管理网卡 IPv4（/24）', values['ip'], required=True)
                suggested = values['ip'].rsplit('.', 1)[0] + '.1'
                values['gateway'] = prompt('默认网关', values['gateway'] or suggested)
            values['bridge1'] = select_bridge(bridges, '内部网卡 eth1：连接内部网络或路由设备；地址可稍后配置。', values['bridge1'])
            values['internal'] = prompt('内部网卡 IPv4（/24）', values['internal'])
            try:
                valid_id(values['ctid'])
                number(values['cores'], 1, os.cpu_count() or 1)
                number(values['memory'], 256, 1048576)
                number(values['disk'], 2, 65536)
                if not re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?', values['name']):
                    raise ValueError('容器名称请使用字母、数字和连字符。')
                if values['storage'] not in stores or any(values[key] not in bridge_names for key in ('bridge0', 'bridge1')):
                    raise ValueError('请选择列出的存储和网桥。')
                if values['mode'] not in ('1', '2'):
                    raise ValueError('管理地址方式请选择 1 或 2。')
                if values['mode'] == '2':
                    ipv4(values['ip']); ipv4(values['gateway'])
                    if ipaddress.IPv4Address(values['gateway']) not in ipaddress.ip_network(values['ip'] + '/24', strict=False):
                        raise ValueError('网关需要与管理地址处于同一个 /24 网段。')
                if values['internal']:
                    ipv4(values['internal'])
            except ValueError as error:
                print('  ' + str(error)); continue
            heading('安装 / 确认参数')
            print(f"  编号 / 名称   {values['ctid']} / {values['name']}\n  CPU / 内存    {values['cores']} 核 / {values['memory']} MiB\n  磁盘 / 存储   {values['disk']} GiB / {values['storage']}")
            print(f"  管理 eth0     {values['bridge0']} / " + ('DHCP' if values['mode'] == '1' else '静态 ' + values['ip'] + '/24，网关 ' + values['gateway']) + '（后台访问 / 默认出口）')
            print(f"  内部 eth1     {values['bridge1']} / " + ('静态 ' + values['internal'] + '/24' if values['internal'] else '稍后配置 IP（manual）') + '（内部网络）')
            print('  DNS           继承 PVE 宿主机\n  TUN 设备权限  将授权给 Core 服务账号\n  IPv4 转发     将在容器内开启\n  Core TUN      由应用的配置决定；初始配置关闭')
            choice = input('\n  [1] 确认安装  [2] 修改参数  [0] 返回：').strip()
            if choice == '0': return
            if choice == '1': break
        ctid = values['ctid']
        run('pvesh', 'get', '/cluster/nextid', '--vmid', ctid, capture=True)
        print('  正在准备并校验模板……', flush=True)
        archive = asset(template, work, 'template.tar.zst', local_root)
        if not Path('/dev/net/tun').exists(): run('modprobe', 'tun')
        device = os.stat('/dev/net/tun').st_rdev
        if (os.major(device), os.minor(device)) != (10, 200): raise ValueError('TUN 设备异常。')
        for field in ('serviceUid', 'serviceGid'):
            number(str(template[field]), 1, 65533)
        net0 = f"name=eth0,bridge={values['bridge0']},ip=" + ('dhcp' if values['mode'] == '1' else values['ip'] + '/24,gw=' + values['gateway'])
        net1 = f"name=eth1,bridge={values['bridge1']},ip=" + (values['internal'] + '/24' if values['internal'] else 'manual')
        print('  正在创建容器……', flush=True)
        run('pct', 'create', ctid, str(archive), '--ostype', 'debian', '--arch', 'amd64', '--unprivileged', '1', '--features', 'nesting=1',
            '--hostname', values['name'], '--cores', values['cores'], '--memory', values['memory'], '--swap', '256',
            '--rootfs', values['storage'] + ':' + values['disk'], '--net0', net0, '--net1', net1,
            '--dev0', f"path=/dev/net/tun,uid={template['serviceUid']},gid={template['serviceGid']},mode=0660", '--onboot', '0',
            '--description', 'Mihomo Manager PVE')
        run('pct', 'start', ctid)
        print('  等待初始化和管理地址……', flush=True)
        management_ip(ctid, 60)
        run('pct', 'exec', ctid, '--', NODE, APP + '/deploy/debian/health.mjs')
        run('pct', 'exec', ctid, '--', 'systemctl', 'is-active', 'mihomo-manager-core', 'mihomo-manager-configd', 'mihomo-manager-logd', 'mihomo-manager-sysinfo', 'mihomo-manager-web')
        run('pct', 'set', ctid, '--onboot', '1')
        heading('安装完成')
        info(ctid)
        print('\n  TUN 设备权限已准备，容器 IPv4 转发已开启。\n  Core TUN 由应用的配置决定；初始配置关闭，请在后台配置并应用。')


def check_environment_archive(path):
    names, total = set(), 0
    with tarfile.open(path, 'r:gz') as archive:
        for item in archive:
            name = item.name.removeprefix('./').rstrip('/')
            if name in ('', '.') and item.isdir(): continue
            parts = PurePosixPath(name).parts
            if name.startswith('/') or '..' in parts or not (item.isfile() or item.isdir()) or name in names:
                raise ValueError('环境包包含不支持的路径或类型。')
            if name not in ('node', 'environment.json', 'environment-update.sh', 'runtime-artifact.sh', 'runtime.tar.gz') and not name.startswith('node/'):
                raise ValueError('环境包包含范围外文件。')
            names.add(name); total += item.size
            if total > 512 * 1024**2 or len(names) > 10000: raise ValueError('环境包超出大小限制。')
    if not {'environment.json', 'environment-update.sh', 'runtime-artifact.sh', 'runtime.tar.gz', 'node/bin/node'} <= names:
        raise ValueError('环境包内容不完整。')


def update(local):
    ctid = valid_id(prompt('容器编号', '120'))
    run('pct', 'exec', ctid, '--', 'test', '-f', '/etc/mihomo-manager/runtime-only')
    current = current_version(ctid)
    with tempfile.TemporaryDirectory(prefix='mihomo-pve-', dir='/var/tmp') as temporary:
        work = Path(temporary)
        release, local_root = manifest(local, work)
        environment = release['environment']
        target = environment.get('managerVersion', '')
        if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', current) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', target):
            raise ValueError('无法确认管理器版本。')
        if tuple(map(int, current.split('.'))) > tuple(map(int, target.split('.'))):
            raise ValueError('环境包的管理器版本较旧，请等待匹配的环境发布。')
        heading('更新 / 确认内容')
        print(f'  容器 {ctid}：{current} → {target}')
        print('  更新管理器、Node、Nginx 配置、服务定义和受限安装器。\n  保留用户配置、认证、网络、Core 二进制和机器身份。\n  本次维护会重启五个项目服务，包括 Core，代理会短暂中断。')
        if input('\n  [1] 确认更新  [0] 返回：').strip() != '1': return
        archive = asset(environment, work, 'environment.tar.gz', local_root)
        check_environment_archive(archive)
        stage = '/var/tmp/mihomo-environment-' + uuid.uuid4().hex
        run('pct', 'exec', ctid, '--', 'mkdir', '-m', '700', stage)
        run('pct', 'push', ctid, str(archive), stage + '/environment.tar.gz', '--perms', '0600')
        run('pct', 'exec', ctid, '--', 'tar', '-xzf', stage + '/environment.tar.gz', '-C', stage, '--no-same-owner')
        run('pct', 'exec', ctid, '--', 'bash', stage + '/environment-update.sh', 'install')
        run('pct', 'exec', ctid, '--', 'rm', '-rf', '--', stage)
        info(ctid)


def main():
    parser = argparse.ArgumentParser(description='Mihomo Manager PVE')
    parser.add_argument('--manifest', help='Root-owned local candidate manifest for acceptance')
    args = parser.parse_args()
    if os.geteuid() != 0 or not Path('/etc/pve').is_dir(): raise ValueError('请在 PVE 宿主机以 root 运行。')
    if os.uname().machine != 'x86_64': raise ValueError('当前支持 amd64 PVE。')
    while True:
        heading('PVE 容器管理')
        print('  [1] 安装\n      创建预装 Mihomo Manager 的容器\n\n  [2] 更新\n      维护已有容器的程序与运行环境\n\n  [3] 查看容器信息\n      查询后台地址、版本与资源\n\n  [0] 退出\n')
        choice = input('  请选择 [1 / 2 / 3 / 0]：').strip()
        if choice == '0': return
        if choice == '1': install(args.manifest)
        elif choice == '2': update(args.manifest)
        elif choice == '3': info()
        else: continue
        input('\n  按回车返回主菜单。')


if __name__ == '__main__':
    try:
        main()
    except (EOFError, KeyboardInterrupt):
        print('\n  已退出。')
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print('\n  操作停止：' + str(error), flush=True)
        raise SystemExit(1)
