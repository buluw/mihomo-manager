import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_RUNTIME_BYTES, PackageError, validateRuntimePackage } from '../../release/package.mjs';

const execute = promisify(execFile);
const components = ['frontend', 'configd', 'logd', 'sysinfo'];
const directories = components.map(name => name + '/dist').concat(['configd/node_modules/yaml', 'licenses']);
const files = components.map(name => name + '/package.json').concat(['release/package.mjs', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
  'THIRD_PARTY_LICENSES.txt', 'DEPENDENCIES.json', 'SOURCE_METADATA.json', 'SOURCE_FILES_SHA256', 'RUNTIME_BUILD.json', 'BUILD_PROVENANCE.json']);
const scopes = [...directories, ...files];
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new PackageError(code); };

async function atomicJson(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o644 });
  await chmod(temporary, 0o644); await rename(temporary, path);
}
async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function regularFiles(root, scope, output) {
  const path = join(root, scope), info = await lstat(path);
  if (info.isSymbolicLink()) fail('webui_invalid_program');
  if (info.isDirectory()) {
    for (const entry of (await readdir(path)).sort()) await regularFiles(root, scope + '/' + entry, output);
  } else if (info.isFile()) output.set(scope, digest(await readFile(path)));
  else fail('webui_invalid_program');
}
export async function programIdentity(root) {
  const entries = new Map(), hashes = {};
  for (const scope of scopes) {
    if (!existsSync(join(root, scope))) { hashes[scope] = null; continue; }
    const selected = new Map(); await regularFiles(root, scope, selected);
    hashes[scope] = digest(JSON.stringify([...selected]));
    for (const item of selected) entries.set(...item);
  }
  const packages = await Promise.all(components.map(component => readJson(join(root, component, 'package.json'), null)));
  if (packages.some(pkg => !pkg || !/^\d+\.\d+\.\d+$/.test(pkg.version)) || new Set(packages.map(pkg => pkg.version)).size !== 1) fail('webui_invalid_program');
  const proof = await readJson(join(root, 'BUILD_PROVENANCE.json'), null);
  const compiled = [...entries.keys()].filter(path => /^(frontend|configd|logd|sysinfo)\/dist\//.test(path));
  const verified = proof?.artifacts?.length === compiled.length && proof.artifacts.every(item => entries.get(item.path) === item.sha256)
    && /^[a-f0-9]{64}$/.test(proof.sourceManifestSha256 ?? '');
  return { version: packages[0].version, sha256: digest(JSON.stringify(hashes)), sourceSha256: verified ? proof.sourceManifestSha256 : null, hashes };
}
async function snapshot(source, target) {
  await mkdir(target, { mode: 0o700 });
  for (const scope of scopes) if (existsSync(join(source, scope))) {
    await mkdir(dirname(join(target, scope)), { recursive: true, mode: 0o755 });
    await cp(join(source, scope), join(target, scope), { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
  }
}
async function readableTree(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) fail('webui_invalid_program');
  if (info.isDirectory()) {
    await chmod(path, 0o755);
    for (const child of await readdir(path)) await readableTree(join(path, child));
  } else if (info.isFile()) await chmod(path, 0o644);
  else fail('webui_invalid_program');
}
function affectedServices(changes) {
  const affected = new Set();
  for (const { path } of changes) {
    const component = path.split('/')[0];
    if (components.includes(component)) affected.add(component === 'frontend' ? 'web' : component);
    if (['release/package.mjs', 'BUILD_PROVENANCE.json', 'SOURCE_METADATA.json', 'RUNTIME_BUILD.json'].includes(path)) affected.add('sysinfo');
  }
  return ['web', 'configd', 'logd', 'sysinfo'].filter(service => affected.has(service));
}
const publicIdentity = ({ version, sha256, sourceSha256 }) => ({ version, sha256, sourceSha256 });

export async function recoverWebUi(paths, operations) {
  const journal = await readJson(join(paths.privateDirectory, 'transaction.json'), null);
  if (!journal) return null;
  if (!Array.isArray(journal.changes) || journal.changes.some(item => !scopes.includes(item.path))
    || !Array.isArray(journal.services) || journal.services.some(name => !['web', 'configd', 'logd', 'sysinfo'].includes(name))) fail('webui_recovery_failed');
  if (journal.phase === 'committed') {
    const old = join(paths.privateDirectory, 'transaction', 'old-image');
    const previous = join(paths.privateDirectory, 'previous');
    if (existsSync(old)) {
      if (existsSync(previous)) await rename(previous, join(paths.privateDirectory, 'transaction', 'retired'));
      await rename(old, previous);
    }
    await atomicJson(join(paths.stateDirectory, 'status.json'), journal.status);
    await rm(join(paths.privateDirectory, 'transaction'), { recursive: true, force: true });
    await rm(join(paths.privateDirectory, 'transaction.json'), { force: true });
    return journal.status;
  }
  const transaction = join(paths.privateDirectory, 'transaction');
  if (journal.phase !== 'preparing') await operations.stop(journal.services);
  for (const change of [...journal.changes].reverse()) {
    const current = join(paths.app, change.path), replaced = join(transaction, 'replaced', change.path);
    if (existsSync(replaced)) {
      await rm(current, { recursive: true, force: true });
      await mkdir(dirname(current), { recursive: true, mode: 0o755 });
      await rename(replaced, current);
    } else if (!change.oldPresent) await rm(current, { recursive: true, force: true });
  }
  if (journal.phase !== 'preparing') {
    await operations.start(journal.services);
    if (!await operations.health() || await operations.coreIdentity() !== journal.core) fail('webui_recovery_failed');
  }
  const state = { ...journal.status, phase: journal.phase === 'preparing' ? 'failed' : 'rolled-back', busy: false,
    error: journal.status.error ?? (journal.phase === 'preparing' ? 'webui_task_interrupted' : 'webui_install_failed_restored'), finishedAt: new Date().toISOString() };
  await atomicJson(join(paths.stateDirectory, 'status.json'), state);
  await rm(transaction, { recursive: true, force: true });
  await rm(join(paths.privateDirectory, 'transaction.json'), { force: true });
  return state;
}

export async function switchWebUi(request, paths, operations, accepted = async () => {}) {
  if (!['install', 'rollback'].includes(request.action) || !/^[a-f0-9]{64}$/.test(request.sha256)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.id)) fail('webui_invalid_request');
  if (await realpath(paths.app) !== resolve(paths.app)) fail('webui_invalid_program');
  if (existsSync(join(paths.privateDirectory, 'transaction.json'))) await recoverWebUi(paths, operations);
  const previousStatus = await readJson(join(paths.stateDirectory, 'status.json'), { previous: null });
  const status = { version: 1, id: request.id, action: request.action, sha256: request.sha256,
    phase: request.action === 'install' ? 'installing' : 'rolling-back', busy: true, error: null,
    startedAt: new Date().toISOString(), finishedAt: null, previous: previousStatus.previous, services: [] };
  const transaction = join(paths.privateDirectory, 'transaction'), previous = join(paths.privateDirectory, 'previous');
  let journal = { phase: 'preparing', changes: [], services: [], status, core: null };
  await atomicJson(join(paths.privateDirectory, 'transaction.json'), journal);
  await atomicJson(join(paths.stateDirectory, 'status.json'), status);
  await accepted();
  try {
    await mkdir(transaction, { mode: 0o700 });
    const original = await programIdentity(paths.app), core = await operations.coreIdentity();
    const incoming = join(transaction, 'incoming');
    if (request.action === 'install') {
      const input = await open(join(paths.downloadDirectory, 'candidate.tar.gz'), constants.O_RDONLY | constants.O_NOFOLLOW);
      const archive = join(transaction, 'candidate.tar.gz');
      try {
        const info = await input.stat({ bigint: true });
        if (!info.isFile() || info.size <= 0n || info.size > BigInt(MAX_RUNTIME_BYTES)) fail('webui_invalid_package');
        const output = await open(archive, 'wx', 0o600), hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
        let size = 0;
        try {
          for (;;) {
            const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            size += bytesRead; if (size > MAX_RUNTIME_BYTES) fail('file_too_large');
            const bytes = buffer.subarray(0, bytesRead); hash.update(bytes); await output.writeFile(bytes);
          }
          const after = await input.stat({ bigint: true });
          if (hash.digest('hex') !== request.sha256 || info.size !== after.size || info.mtimeNs !== after.mtimeNs || info.ctimeNs !== after.ctimeNs) fail('candidate_changed');
          await output.sync();
        } finally { await output.close(); }
      } finally { await input.close(); }
      await validateRuntimePackage(archive, incoming, { expectedSha256: request.sha256 });
    } else {
      const identity = await programIdentity(previous);
      if (identity.sha256 !== request.sha256 || previousStatus.previous?.sha256 !== request.sha256) fail('previous_unavailable');
      await snapshot(previous, incoming);
    }
    const target = await programIdentity(incoming);
    const changes = scopes.filter(path => original.hashes[path] !== target.hashes[path]).map(path => ({ path, oldPresent: original.hashes[path] !== null, newPresent: target.hashes[path] !== null }));
    status.services = affectedServices(changes);
    await snapshot(paths.app, join(transaction, 'old-image'));
    if ((await programIdentity(paths.app)).sha256 !== original.sha256) fail('webui_program_changed');
    journal = { phase: 'switching', changes, services: status.services, status, core };
    await atomicJson(join(paths.privateDirectory, 'transaction.json'), journal);
    await atomicJson(join(paths.stateDirectory, 'status.json'), status);
    await operations.stop(status.services);
    for (const change of changes) {
      const current = join(paths.app, change.path), replacement = join(incoming, change.path), old = join(transaction, 'replaced', change.path);
      await mkdir(dirname(old), { recursive: true, mode: 0o700 });
      if (change.oldPresent) await rename(current, old);
      if (change.newPresent) {
        await mkdir(dirname(current), { recursive: true, mode: 0o755 });
        await chmod(dirname(current), 0o755);
        await readableTree(replacement); await rename(replacement, current);
      }
    }
    await operations.start(status.services);
    if (!await operations.health()) fail('webui_health_failed');
    if (await operations.coreIdentity() !== core) fail('webui_core_changed');
    if ((await programIdentity(paths.app)).sha256 !== target.sha256) fail('webui_program_changed');
    status.previous = publicIdentity(original); status.phase = request.action === 'rollback' ? 'rolled-back' : 'succeeded';
    status.busy = false; status.finishedAt = new Date().toISOString();
    journal.phase = 'committed'; journal.status = status;
    await atomicJson(join(paths.privateDirectory, 'transaction.json'), journal);
    return await recoverWebUi(paths, operations);
  } catch (error) {
    if (journal.phase === 'preparing') {
      journal.status.error = error instanceof PackageError ? error.code : 'webui_install_failed';
      await atomicJson(join(paths.privateDirectory, 'transaction.json'), journal);
    } else if (journal.phase !== 'committed') {
      journal.status.error = error instanceof PackageError && error.code === 'webui_health_failed' ? 'webui_startup_failed_restored' : 'webui_install_failed_restored';
      await atomicJson(join(paths.privateDirectory, 'transaction.json'), journal);
    }
    try { return await recoverWebUi(paths, operations); }
    catch { status.error = 'webui_recovery_failed'; }
    status.phase = 'failed'; status.busy = false; status.finishedAt = new Date().toISOString();
    await atomicJson(join(paths.stateDirectory, 'status.json'), status);
    return status;
  }
}

function productionOperations() {
  const units = names => {
    if (names.some(name => !['web', 'configd', 'logd', 'sysinfo'].includes(name))) fail('webui_invalid_request');
    return names.map(name => 'mihomo-manager-' + name + '.service');
  };
  return {
    stop: async names => { if (names.length) await execute('/usr/bin/systemctl', ['stop', ...units(names)], { timeout: 45000 }); },
    start: async names => { if (names.length) await execute('/usr/bin/systemctl', ['start', ...units(names)], { timeout: 45000 }); },
    health: async () => {
      try { await execute(process.execPath, [fileURLToPath(new URL('./health.mjs', import.meta.url))], { timeout: 110000 }); return true; }
      catch { return false; }
    },
    coreIdentity: async () => (await execute('/usr/bin/systemctl', ['show', 'mihomo-manager-core.service',
      '-p', 'MainPID', '-p', 'ExecMainStartTimestampMonotonic', '-p', 'ActiveState'], { timeout: 5000 })).stdout,
  };
}
async function readRequest() {
  return new Promise((resolveRequest, reject) => {
    let body = '';
    const timer = setTimeout(() => reject(new Error()), 5000);
    process.stdin.on('data', chunk => {
      body += chunk.toString('utf8');
      if (body.length > 1024) { clearTimeout(timer); reject(new Error()); return; }
      if (!body.includes('\n')) return;
      clearTimeout(timer); process.stdin.pause();
      try { resolveRequest(JSON.parse(body.trim())); } catch { reject(new Error()); }
    });
    process.stdin.on('error', reject);
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.on('error', () => {});
  const paths = { app: '/opt/mihomo-manager/app', privateDirectory: '/opt/mihomo-manager/.webui-update',
    downloadDirectory: process.env.WEBUI_UPDATE_DIR ?? '/var/lib/mihomo-manager/webui-update',
    stateDirectory: '/var/lib/mihomo-manager-webui-install' };
  let acknowledged = false;
  try {
    if (process.getuid?.() !== 0) throw new Error();
    if (process.argv[2] === 'recover') await recoverWebUi(paths, productionOperations());
    else {
      const request = await readRequest();
      await switchWebUi(request, paths, productionOperations(), async () => {
        acknowledged = true;
        await new Promise(done => process.stdout.write(JSON.stringify({ accepted: true, id: request.id }) + '\n', done));
        process.stdin.destroy();
      });
    }
  } catch {
    if (!acknowledged && process.argv[2] !== 'recover') process.stdout.write(JSON.stringify({ error: 'rejected' }) + '\n');
    process.exitCode = 1;
  }
}
