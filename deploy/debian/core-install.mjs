// Installed root-owned beside the fixed control helper; stdin accepts no paths.
import { constants } from 'node:fs';
import { open, copyFile, rename, rm, chmod, chown } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const maxBytes = 128 * 1024 * 1024;

async function openRegular(path, limit = maxBytes, followProcessExe = false) {
  const file = await open(path, constants.O_RDONLY | (followProcessExe ? 0 : constants.O_NOFOLLOW));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new Error('invalid');
    return file;
  } catch (error) { await file.close(); throw error; }
}

async function hashFile(file, output) {
  const before = await file.stat();
  const digest = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  let size = 0;
  for (;;) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
    if (!bytesRead) break;
    size += bytesRead;
    if (size > maxBytes) throw new Error('invalid');
    const chunk = buffer.subarray(0, bytesRead);
    digest.update(chunk);
    if (output) await output.writeFile(chunk);
  }
  const after = await file.stat();
  if (size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || size !== after.size) throw new Error('invalid');
  return digest.digest('hex');
}

async function regularBytes(path, limit = maxBytes) {
  const file = await openRegular(path, limit);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new Error('invalid');
    return await file.readFile();
  } finally { await file.close(); }
}

export async function switchCore(action, paths, operations) {
  if (action !== 'install' && action !== 'rollback') throw new Error('invalid');
  const { binary, candidate, manifest } = paths;
  const pending = binary + '.next';
  const recovery = binary + '.recovery';
  let stopped = false;
  let pendingCreated = false;
  let recoveryCreated = false;
  let reuseRecovery = false;
  let restored = false;
  let old;
  try {
    const metadata = action === 'install' ? JSON.parse((await regularBytes(manifest, 16384)).toString('utf8')) : null;
    if (metadata && !/^[a-f0-9]{64}$/.test(metadata.sha256)) throw new Error('invalid');
    // The copy is immutable to the service user before it is probed or installed.
    const source = await openRegular(action === 'install' ? candidate : binary + '.previous');
    try {
      const file = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o755);
      pendingCreated = true;
      try {
        const digest = await hashFile(source, file);
        if (metadata && digest !== metadata.sha256) throw new Error('invalid');
        await file.sync();
      } finally { await file.close(); }
    } finally { await source.close(); }
    await operations.own(pending);
    const next = await operations.probe(pending);
    // A prior unconfirmed restore can leave the only usable backup here.
    try {
      const recoveryFile = await openRegular(recovery);
      await recoveryFile.close();
      reuseRecovery = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    old = await operations.probe(reuseRecovery ? recovery : binary);
    await operations.validate(pending);
    if (!reuseRecovery) {
      await copyFile(binary, recovery, constants.COPYFILE_EXCL);
      recoveryCreated = true;
      await operations.own(recovery);
    }
    stopped = true;
    await operations.stop();
    await rename(pending, binary);
    pendingCreated = false;
    await operations.start();
    if (!(await operations.ready(next))) throw new Error('startup');
    await rename(recovery, binary + '.previous');
    recoveryCreated = false;
    return 'ok';
  } catch {
    if (!stopped || !old) return 'failed';
    try {
      await operations.stop();
      await copyFile(recovery, pending);
      pendingCreated = true;
      await operations.own(pending);
      await rename(pending, binary);
      pendingCreated = false;
      await operations.start();
      if (!(await operations.ready(old))) return 'failed';
      restored = true;
      return 'rolled_back';
    } catch { return 'failed'; }
  } finally {
    if (pendingCreated) await rm(pending, { force: true }).catch(() => {});
    if ((recoveryCreated && !stopped) || restored) await rm(recovery, { force: true }).catch(() => {});
  }
}

async function main() {
  const action = process.argv[2];
  if (process.getuid() !== 0 || !['install', 'rollback'].includes(action)) return 'invalid';
  const binary = process.env.MIHOMO_BINARY_PATH;
  const data = process.env.MIHOMO_DATA_DIR;
  const directory = process.env.CORE_UPDATE_DIR;
  if (binary !== '/opt/mihomo-manager/bin/mihomo' || data !== '/var/lib/mihomo-manager' || directory !== '/var/lib/mihomo-manager/core-update') return 'invalid';
  const run = (file, args, timeout = 15000) => execute(file, args, { timeout, maxBuffer: 8192 });
  const userRun = (file, args) => run('/usr/sbin/runuser', ['-u', 'mihomo-manager', '--', file, ...args]);
  const system = action => run('/usr/bin/systemctl', [action, 'mihomo-manager-core.service'], 25000);
  const probe = async path => {
    const file = await openRegular(path);
    const header = Buffer.alloc(64);
    let sha256;
    try {
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      if (bytesRead < 64 || header.subarray(0, 4).toString('hex') !== '7f454c46' || header[4] !== 2 || header[5] !== 1
          || header.readUInt16LE(18) !== ({ x64: 62, arm64: 183 })[process.arch]) throw new Error('invalid');
      sha256 = await hashFile(file);
    } finally { await file.close(); }
    const { stdout } = await userRun(path, ['-v']);
    const match = /^Mihomo Meta (v?[^\s]+) linux (amd64|arm64)\b/.exec(stdout.trim());
    if (!match || match[2] !== (process.arch === 'x64' ? 'amd64' : process.arch)) throw new Error('invalid');
    return { version: match[1], sha256 };
  };
  return switchCore(action, { binary, candidate: directory + '/candidate', manifest: directory + '/candidate.json' }, {
    own: async path => { await chown(path, 0, 0); await chmod(path, 0o755); },
    probe,
    validate: async path => {
      const { stdout } = await userRun('/opt/mihomo-manager/node/bin/node', ['/opt/mihomo-manager/app/deploy/debian/startup-config.mjs']);
      await userRun(path, ['-t', '-d', data, '-f', stdout.trim()]);
    },
    stop: () => system('stop'),
    start: async () => { await system('reset-failed').catch(() => {}); await system('start'); },
    ready: async expected => {
      let consecutive = 0;
      for (let attempt = 0; attempt < 25; attempt++) {
        try {
          const { stdout } = await run('/usr/bin/systemctl', ['show', 'mihomo-manager-core.service', '--property=MainPID', '--value'], 3000);
          const pid = Number(stdout.trim());
          if (!Number.isInteger(pid) || pid <= 0) throw new Error('not_ready');
          const executable = await openRegular(`/proc/${pid}/exe`, maxBytes, true);
          try { if (await hashFile(executable) !== expected.sha256) throw new Error('not_ready'); }
          finally { await executable.close(); }
          const response = await fetch(`${process.env.MIHOMO_CONTROLLER_URL ?? 'http://127.0.0.1:19090'}/version`, {
            headers: process.env.MIHOMO_CONTROLLER_SECRET ? { Authorization: `Bearer ${process.env.MIHOMO_CONTROLLER_SECRET}` } : {}, signal: AbortSignal.timeout(1000),
          });
          if (!response.ok || (await response.json()).version !== expected.version) throw new Error('not_ready');
          if (++consecutive >= 2) return true;
        } catch { consecutive = 0; }
        await delay(500);
      }
      return false;
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(result => process.stdout.write(result + '\n'), () => process.stdout.write('failed\n'));
}
