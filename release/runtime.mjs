import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonFile, publicFiles, sha256, writeJson } from './source.mjs';

const components = ['frontend', 'configd', 'logd', 'sysinfo'];
function artifactHashes(app) {
  const files = [];
  function walk(path) {
    for (const entry of readdirSync(resolve(app, path), { withFileTypes: true })) {
      const child = path + '/' + entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push({ path: child, sha256: sha256(readFileSync(resolve(app, child))) });
      else throw new Error('Build outputs must contain regular files.');
    }
  }
  for (const component of components) walk(component + '/dist');
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export function buildRuntime(app, work) {
  const expected = readFileSync(resolve(work, 'source.sha256'), 'utf8');
  const fingerprint = () => publicFiles(app).map(path => sha256(readFileSync(resolve(app, path))) + '  ' + path + '\n').join('');
  if (fingerprint() !== expected) throw new Error('Build source differs from the public snapshot.');
  for (const component of components) {
    // Only generated outputs of the four fixed components are replaced.
    rmSync(resolve(app, component, 'dist'), { recursive: true, force: true });
    execFileSync('npm', ['run', 'build'], { cwd: resolve(app, component), stdio: 'inherit' });
  }
  if (fingerprint() !== expected) throw new Error('Source changed during the build.');
  const proof = { formatVersion: 1, sourceManifestSha256: sha256(expected), node: process.version, platform: process.platform,
    arch: process.arch, artifacts: artifactHashes(app) };
  writeJson(resolve(app, 'BUILD_PROVENANCE.json'), proof);
  return { sourceManifestSha256: proof.sourceManifestSha256, artifactCount: proof.artifacts.length };
}

export function runtimeMetadata(app, payload, work) {
  const versions = Object.fromEntries(['frontend', 'configd', 'logd', 'sysinfo'].map(component => [component, jsonFile(resolve(payload, component, 'package.json')).version]));
  if (new Set(Object.values(versions)).size !== 1) throw new Error('Runtime component versions differ.');
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.versions.node.split('.')[0] !== '24') {
    throw new Error('This runtime format requires Linux x64 and Node.js 24.');
  }
  for (const component of ['configd', 'logd', 'sysinfo']) {
    const pkg = jsonFile(resolve(payload, component, 'package.json'));
    if (Object.keys(pkg.dependencies ?? {}).sort().join(',') !== (component === 'configd' ? 'yaml' : '')) throw new Error('Runtime dependencies need review.');
  }
  createRequire(resolve(payload, 'configd/package.json'))('yaml').parse('runtime: true');
  const manifest = readFileSync(resolve(work, 'source.sha256'));
  const sourceFile = resolve(work, 'source-metadata.json');
  let source;
  if (existsSync(sourceFile)) {
    source = jsonFile(sourceFile);
    if (source.formatVersion !== 1 || source.version !== versions.frontend || source.manifestSha256 !== sha256(manifest)
      || source.fileCount !== manifest.toString('utf8').trimEnd().split('\n').length || !/^[a-f0-9]{40}$/.test(source.revision)
      || typeof source.dirty !== 'boolean') throw new Error('Source identity does not match the verified manifest.');
    if (source.status === 'release' && (source.dirty || source.tag !== 'v' + versions.frontend)) {
      throw new Error('Formal runtime requires clean source with a matching version tag.');
    }
    const proof = jsonFile(resolve(app, 'BUILD_PROVENANCE.json'));
    if (proof.sourceManifestSha256 !== source.manifestSha256 || proof.node !== process.version || proof.platform !== process.platform
      || proof.arch !== process.arch || JSON.stringify(proof.artifacts) !== JSON.stringify(artifactHashes(app))) throw new Error('Build provenance does not match this source snapshot and artifacts.');
    copyFileSync(resolve(app, 'BUILD_PROVENANCE.json'), resolve(payload, 'BUILD_PROVENANCE.json'));
  } else {
    source = { formatVersion: 1, version: versions.frontend, status: 'snapshot', revision: readFileSync(resolve(app, 'DEPLOYED_REVISION'), 'utf8').trim(),
      dirty: null, manifestSha256: sha256(manifest), identity: 'verified file manifest; worktree state not supplied' };
  }
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.txt']) copyFileSync(resolve(app, name), resolve(payload, name));
  for (const path of publicFiles(app).filter(path => path.startsWith('licenses/'))) {
    mkdirSync(dirname(resolve(payload, path)), { recursive: true });
    copyFileSync(resolve(app, path), resolve(payload, path));
  }
  copyFileSync(resolve(app, 'release/dependencies.json'), resolve(payload, 'DEPENDENCIES.json'));
  writeJson(resolve(payload, 'SOURCE_METADATA.json'), source);
  const status = source.status === 'release' ? 'release' : source.status === 'candidate' ? 'candidate' : 'snapshot';
  const assetName = 'mihomo-manager-v' + versions.frontend
    + (status === 'release' ? '' : '-' + status + '.' + source.manifestSha256.slice(0, 12)) + '-linux-x64.tar.gz';
  const metadata = { formatVersion: 1, packageFormat: 'mihomo-manager-runtime', product: 'mihomo-manager', version: versions.frontend, status, assetName,
    node: process.version, requiredNode: process.version, nodeAbi: process.versions.modules, arch: process.arch, platform: process.platform,
    components: versions, source, webuiUpdateProtocol: 1, packagedAt: new Date().toISOString(), license: 'GPL-3.0-only',
    requirements: { init: 'systemd', webServer: 'nginx', libc: 'glibc', core: 'separately installed Mihomo', installation: 'existing managed runtime-only installation' } };
  writeJson(resolve(payload, 'RUNTIME_BUILD.json'), metadata);
  writeFileSync(resolve(work, 'artifact-name.txt'), assetName + '\n');
  return metadata;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'build') {
    const [, app, work] = process.argv.slice(2);
    if (!app || !work) throw new Error('Usage: node release/runtime.mjs build APP WORK');
    console.log(JSON.stringify(buildRuntime(app, work)));
  } else {
  const [app, payload, work] = process.argv.slice(2);
  if (!app || !payload || !work) throw new Error('Usage: node release/runtime.mjs APP PAYLOAD WORK');
  console.log(JSON.stringify(runtimeMetadata(app, payload, work)));
  }
}
