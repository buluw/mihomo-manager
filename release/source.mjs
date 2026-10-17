import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const jsonFile = path => JSON.parse(readFileSync(path, 'utf8'));
export const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

export function publicFiles(root, manifest = jsonFile(resolve(root, 'release/public-files.json'))) {
  if (manifest.formatVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid public file list.');
  const seen = new Set();
  const base = realpathSync(root);
  return manifest.files.map(path => {
    if (typeof path !== 'string' || isAbsolute(path) || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..') || seen.has(path.toLowerCase())
      || /(^|\/)(\.git|\.agent|node_modules|dist|runtime|ssh|AGENTS\.md|\.env(?:\..*)?)(\/|$)/.test(path)
      || path.startsWith('test/') || path.startsWith('core/bin/') || path.startsWith('frontend/public/assets/')) {
      throw new Error('Public file list contains an excluded or duplicate path.');
    }
    seen.add(path.toLowerCase());
    const target = resolve(base, path);
    if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink() || realpathSync(target) !== target) {
      throw new Error('Public file must be a regular in-tree file: ' + path);
    }
    return path;
  }).sort();
}

export function sourceIdentity(root, files, { release = false } = {}) {
  const manifest = files.map(path => sha256(readFileSync(resolve(root, path))) + '  ' + path + '\n').join('');
  const version = jsonFile(resolve(root, 'frontend/package.json')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('A three-part release version is required.');
  for (const component of ['configd', 'logd', 'sysinfo']) {
    if (jsonFile(resolve(root, component, 'package.json')).version !== version) throw new Error('Component versions differ.');
  }
  let revision, dirty;
  if (existsSync(resolve(root, '.git'))) {
    const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    revision = git(['rev-parse', 'HEAD']);
    dirty = Boolean(git(['status', '--porcelain', '--untracked-files=all']));
    if (release && !git(['tag', '--points-at', 'HEAD']).split(/\r?\n/).includes('v' + version)) {
      throw new Error('Formal release source requires a matching version tag at HEAD.');
    }
  } else if (existsSync(resolve(root, 'SOURCE_METADATA.json'))) {
    const prior = jsonFile(resolve(root, 'SOURCE_METADATA.json'));
    revision = prior.revision;
    dirty = prior.manifestSha256 === sha256(manifest) ? prior.dirty : true;
    if (release && (prior.status !== 'release' || prior.tag !== 'v' + version)) {
      throw new Error('Formal release snapshot requires matching release metadata.');
    }
  } else {
    throw new Error('Source identity requires Git or an exported SOURCE_METADATA.json.');
  }
  if (!/^[a-f0-9]{40}$/.test(revision) || typeof dirty !== 'boolean') throw new Error('Invalid source identity.');
  if (release && dirty) throw new Error('Formal release source must be clean.');
  return { manifest, metadata: { formatVersion: 1, product: 'mihomo-manager', version, status: release ? 'release' : 'candidate',
    ...(release ? { tag: 'v' + version } : {}),
    revision, dirty, manifestSha256: sha256(manifest), fileCount: files.length,
    license: 'GPL-3.0-only', repository: 'https://github.com/buluw/mihomo-manager' } };
}

export function exportSource(root, output, options = {}) {
  const source = realpathSync(root), destination = resolve(output);
  if (existsSync(destination)) throw new Error('Source export destination must be new.');
  const rel = relative(source, destination);
  if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))) {
    throw new Error('Source export destination must be outside the maintained worktree.');
  }
  const files = publicFiles(source);
  const identity = sourceIdentity(source, files, options);
  mkdirSync(destination, { recursive: true });
  for (const path of files) {
    const target = resolve(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(source, path), target);
  }
  const copied = files.map(path => sha256(readFileSync(resolve(destination, path))) + '  ' + path + '\n').join('');
  if (copied !== identity.manifest) throw new Error('Source changed during export; discard this candidate.');
  writeFileSync(resolve(destination, 'SOURCE_FILES_SHA256'), identity.manifest);
  writeJson(resolve(destination, 'SOURCE_METADATA.json'), identity.metadata);
  return identity.metadata;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, output, mode, ...extra] = process.argv.slice(2);
  if (!output || !['export', 'manifest'].includes(command) || (mode && mode !== '--release') || extra.length) {
    throw new Error('Usage: node release/source.mjs export|manifest NEW_DIRECTORY [--release]');
  }
  const options = { release: mode === '--release' };
  if (command === 'export') console.log(JSON.stringify(exportSource(projectRoot, output, options)));
  else {
    if (existsSync(output)) throw new Error('Manifest destination must be new.');
    const identity = sourceIdentity(projectRoot, publicFiles(projectRoot), options);
    mkdirSync(output, { recursive: true });
    writeFileSync(resolve(output, 'source.sha256'), identity.manifest);
    writeJson(resolve(output, 'source-metadata.json'), identity.metadata);
    console.log(JSON.stringify(identity.metadata));
  }
}
