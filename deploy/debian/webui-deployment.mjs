import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readableTree } from './webui-install.mjs';

// Root-controlled deployment configuration; browser requests cannot select these paths.
export async function installWebUiUpdater(app, environment = '/etc/mihomo-manager/manager.env') {
  const line = readFileSync(environment, 'utf8').split(/\r?\n/).findLast(value => /^WEBUI_UPDATE_DIR=/.test(value));
  const directory = line?.slice('WEBUI_UPDATE_DIR='.length).trim().replace(/^(["'])(.*)\1$/, '$2') ?? '/var/lib/mihomo-manager/webui-update';
  if (!/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(directory) || directory.split('/').some(part => part === '..' || part === '.')
    || directory === '/var/lib/mihomo-manager' || directory.startsWith('/opt/') || directory.startsWith('/etc/') || directory.startsWith('/run/')) throw new Error('Invalid Web UI update directory.');
  const install = (...args) => execFileSync('/usr/bin/install', args);
  install('-d', '-o', 'mihomo-manager', '-g', 'mihomo-manager', '-m', '700', directory);
  install('-d', '-o', 'root', '-g', 'mihomo-manager', '-m', '750', '/opt/mihomo-manager/.webui-update');
  const previous = '/opt/mihomo-manager/.webui-update/previous';
  if (existsSync(previous)) await readableTree(previous);
  install('-d', '-o', 'root', '-g', 'root', '-m', '755', '/var/lib/mihomo-manager-webui-install',
    '/usr/local/libexec/mihomo-manager-webui/deploy/debian', '/usr/local/libexec/mihomo-manager-webui/release',
    '/etc/systemd/system/mihomo-manager-sysinfo.service.d');
  for (const file of ['deploy/debian/webui-install.mjs', 'deploy/debian/health.mjs', 'release/package.mjs']) {
    install('-o', 'root', '-g', 'root', '-m', '644', resolve(app, file), '/usr/local/libexec/mihomo-manager-webui/' + file);
  }
  install('-o', 'root', '-g', 'root', '-m', '755', resolve(app, 'deploy/debian/webui-control.sh'), '/usr/local/libexec/mihomo-manager-webui-control');
  for (const name of ['mihomo-manager-webui-update.socket', 'mihomo-manager-webui-update@.service', 'mihomo-manager-webui-recover.service']) {
    install('-o', 'root', '-g', 'root', '-m', '644', resolve(app, 'deploy/debian', name), '/etc/systemd/system/' + name);
  }
  writeFileSync('/etc/systemd/system/mihomo-manager-sysinfo.service.d/30-webui-update.conf', '[Service]\nReadWritePaths=' + directory + '\n', { mode: 0o644 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.getuid?.() !== 0) throw new Error('Root deployment required.');
  await installWebUiUpdater(process.argv[2] ?? '/opt/mihomo-manager/app');
}
