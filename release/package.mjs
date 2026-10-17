import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createGunzip } from 'node:zlib';

export const MAX_RUNTIME_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 10000;
const repository = 'https://github.com/buluw/mihomo-manager';
const components = ['frontend', 'configd', 'logd', 'sysinfo'];
const rootFiles = new Set(['LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.txt', 'DEPENDENCIES.json',
  'SOURCE_METADATA.json', 'SOURCE_FILES_SHA256', 'RUNTIME_BUILD.json', 'BUILD_PROVENANCE.json', 'RUNTIME_FILES_SHA256',
  'DEPLOYED_REVISION', 'DEPLOYED_ARCHIVE_SHA256']);
export class PackageError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new PackageError(code); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function runtimeArchiveHash(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_RUNTIME_BYTES) || before.size === 0n) fail('webui_invalid_package');
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > MAX_RUNTIME_BYTES) fail('file_too_large');
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('candidate_changed');
    return hash.digest('hex');
  } finally { await file.close(); }
}

function memberPath(value, directory = false) {
  if (value.startsWith('./')) value = value.slice(2);
  if (directory && value.endsWith('/')) value = value.slice(0, -1);
  if (!value && directory) return '';
  if (!value || value.length > 255 || !/^[A-Za-z0-9._@+/-]+$/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) fail('webui_invalid_package');
  return value;
}

function allowedFile(path) {
  return rootFiles.has(path) || /^(frontend|configd|logd|sysinfo)\/package\.json$/.test(path)
    || /^(frontend|configd|logd|sysinfo)\/dist\/.+/.test(path) || path.startsWith('configd/node_modules/yaml/')
    || /^deploy\/debian\/[A-Za-z0-9._@+-]+$/.test(path) || /^licenses\/[A-Za-z0-9._+-]+$/.test(path)
    || path === 'release/package.mjs';
}

function octal(bytes) {
  const text = bytes.toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(text)) fail('webui_invalid_package');
  const number = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(number) || number < 0) fail('webui_invalid_package');
  return number;
}

async function extract(archive, directory) {
  const input = createReadStream(archive), stream = input.pipe(createGunzip());
  input.on('error', error => stream.destroy(error));
  const files = new Map(), seen = new Set();
  let buffered = Buffer.alloc(0), expanded = 0, zeroBlocks = 0, padding = 0, pending = null;
  try {
    for await (const chunk of stream) {
      expanded += chunk.length;
      if (expanded > MAX_EXPANDED_BYTES) fail('file_too_large');
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (pending) {
          const count = Math.min(pending.remaining, buffered.length);
          if (count) {
            const bytes = buffered.subarray(0, count);
            await pending.file.writeFile(bytes); pending.hash.update(bytes);
            pending.remaining -= count; buffered = buffered.subarray(count);
          }
          if (pending.remaining) break;
          await pending.file.close();
          files.set(pending.path, { sha256: pending.hash.digest('hex'), size: pending.size });
          padding = (512 - pending.size % 512) % 512; pending = null;
        }
        if (padding) {
          const count = Math.min(padding, buffered.length);
          if (buffered.subarray(0, count).some(byte => byte !== 0)) fail('webui_invalid_package');
          buffered = buffered.subarray(count); padding -= count;
          if (padding) break;
        }
        if (buffered.length < 512) break;
        const header = buffered.subarray(0, 512); buffered = buffered.subarray(512);
        if (header.every(byte => byte === 0)) { zeroBlocks++; continue; }
        if (zeroBlocks) fail('webui_invalid_package');
        const expected = octal(header.subarray(148, 156));
        let checksum = 0;
        for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
        if (checksum !== expected || !header.subarray(257, 263).toString('ascii').startsWith('ustar')) fail('webui_invalid_package');
        const type = header[156], isDirectory = type === 53;
        if (!isDirectory && type !== 48 && type !== 0) fail('webui_invalid_package');
        const text = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\0.*$/, '');
        const prefix = text(header.subarray(345, 500));
        const path = memberPath((prefix ? prefix + '/' : '') + text(header.subarray(0, 100)), isDirectory);
        const size = octal(header.subarray(124, 136));
        if (size > MAX_EXPANDED_BYTES || seen.has(path) || seen.size >= MAX_FILES) fail('webui_invalid_package');
        seen.add(path);
        if (isDirectory) {
          if (size !== 0 || (path && !['frontend', 'configd', 'logd', 'sysinfo', 'deploy', 'licenses', 'release'].includes(path.split('/')[0]))) fail('webui_invalid_package');
          if (path) await mkdir(resolve(directory, path), { recursive: true, mode: 0o755 });
        } else {
          if (!allowedFile(path)) fail('webui_invalid_package');
          const target = resolve(directory, path);
          await mkdir(dirname(target), { recursive: true, mode: 0o755 });
          const file = await open(target, 'wx', 0o644);
          pending = { file, path, size, remaining: size, hash: createHash('sha256') };
        }
      }
    }
    if (pending || padding || zeroBlocks < 2 || buffered.some(byte => byte !== 0)) fail('webui_invalid_package');
    return files;
  } finally {
    input.destroy(); stream.destroy();
    if (pending) await pending.file.close().catch(() => {});
  }
}

export async function validateRuntimePackage(archive, directory, options = {}) {
  let created = false;
  try {
    const sha256 = await runtimeArchiveHash(archive);
    if (options.expectedSha256 && options.expectedSha256 !== sha256) fail('checksum_mismatch');
    await mkdir(directory, { mode: 0o700 }); created = true;
    const files = await extract(archive, directory);
    const text = async path => {
      const info = files.get(path);
      if (!info || info.size > 2 * 1024 * 1024) fail('webui_invalid_package');
      return readFile(resolve(directory, path), 'utf8');
    };
    const json = async path => JSON.parse(await text(path));
    const inventory = new Map();
    for (const line of (await text('RUNTIME_FILES_SHA256')).trimEnd().split('\n')) {
      const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
      if (!match) fail('webui_invalid_package');
      const path = memberPath(match[2]);
      if (inventory.has(path) || path === 'RUNTIME_FILES_SHA256' || files.get(path)?.sha256 !== match[1]) fail('checksum_mismatch');
      inventory.set(path, match[1]);
    }
    if (inventory.size !== files.size - 1) fail('checksum_mismatch');
    const metadata = await json('RUNTIME_BUILD.json'), source = await json('SOURCE_METADATA.json');
    if (metadata.formatVersion !== 1 || metadata.packageFormat !== 'mihomo-manager-runtime' || metadata.product !== 'mihomo-manager'
      || !/^\d+\.\d+\.\d+$/.test(metadata.version ?? '') || source.product !== 'mihomo-manager' || source.repository !== repository
      || source.version !== metadata.version || !/^[a-f0-9]{40}$/.test(source.revision ?? '') || typeof source.dirty !== 'boolean'
      || !/^[a-f0-9]{64}$/.test(source.manifestSha256 ?? '') || JSON.stringify(metadata.source) !== JSON.stringify(source)) fail('webui_invalid_package');
    if (metadata.node !== (options.node ?? process.version) || metadata.arch !== (options.arch ?? process.arch)
      || metadata.platform !== (options.platform ?? process.platform) || metadata.platform !== 'linux') fail('webui_environment_mismatch');
    if (options.expectedVersion && metadata.version !== options.expectedVersion.replace(/^v/, '')) fail('version_mismatch');
    if (metadata.webuiUpdateProtocol !== 1 || !files.has('sysinfo/dist/webuiUpdate/service.js') || !files.has('release/package.mjs')) fail('webui_package_unsupported');
    if (digest(await text('SOURCE_FILES_SHA256')) !== source.manifestSha256) fail('checksum_mismatch');
    for (const component of components) {
      const pkg = await json(component + '/package.json');
      if (pkg.version !== metadata.version || metadata.components?.[component] !== metadata.version) fail('version_mismatch');
      if (component !== 'frontend' && Object.keys(pkg.dependencies ?? {}).sort().join(',') !== (component === 'configd' ? 'yaml' : '')) fail('webui_package_unsupported');
    }
    for (const path of ['frontend/dist/index.html', 'configd/dist/index.js', 'logd/dist/index.js', 'sysinfo/dist/index.js',
      'sysinfo/dist/access/http.js', 'configd/node_modules/yaml/package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.txt']) if (!files.has(path)) fail('webui_invalid_package');
    const proof = await json('BUILD_PROVENANCE.json');
    if (proof.formatVersion !== 1 || proof.node !== metadata.node || proof.platform !== metadata.platform || proof.arch !== metadata.arch
      || proof.sourceManifestSha256 !== source.manifestSha256 || !Array.isArray(proof.artifacts)) fail('checksum_mismatch');
    const compiled = new Set([...files.keys()].filter(path => /^(frontend|configd|logd|sysinfo)\/dist\//.test(path)));
    for (const item of proof.artifacts) {
      if (!compiled.delete(item.path) || files.get(item.path)?.sha256 !== item.sha256) fail('checksum_mismatch');
    }
    if (compiled.size || await runtimeArchiveHash(archive) !== sha256) fail('candidate_changed');
    return { version: metadata.version, sha256, sourceSha256: source.manifestSha256, revision: source.revision, dirty: source.dirty,
      protocol: 1, fileCount: files.size, node: metadata.node, arch: metadata.arch, platform: metadata.platform };
  } catch (error) {
    if (created) await rm(directory, { recursive: true, force: true });
    if (error instanceof PackageError) throw error;
    throw new PackageError('webui_invalid_package');
  }
}
