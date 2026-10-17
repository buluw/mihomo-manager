import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function fixture(t, mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'webui-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = new Map();
  const put = (path, value) => files.set(path, typeof value === 'string' ? value : JSON.stringify(value));
  const sourceManifest = '0'.repeat(64) + '  README.md\n';
  const source = { formatVersion: 1, product: 'mihomo-manager', version: '0.2.0', repository: 'https://github.com/buluw/mihomo-manager',
    revision: '1'.repeat(40), dirty: true, manifestSha256: sha(sourceManifest) };
  const components = Object.fromEntries(['frontend', 'configd', 'logd', 'sysinfo'].map(name => [name, '0.2.0']));
  for (const component of Object.keys(components)) {
    put(component + '/package.json', { name: component, version: '0.2.0', dependencies: component === 'configd' ? { yaml: '^2.9.0' } : {} });
    put(component + '/dist/' + (component === 'frontend' ? 'index.html' : 'index.js'), 'fixture\n');
  }
  put('sysinfo/dist/webuiUpdate/service.js', 'fixture updater\n');
  put('sysinfo/dist/access/http.js', 'fixture access\n');
  put('configd/node_modules/yaml/package.json', { name: 'yaml', version: '2.9.0' });
  put('release/package.mjs', 'fixture validator\n');
  for (const path of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.txt']) put(path, 'fixture\n');
  put('SOURCE_FILES_SHA256', sourceManifest); put('SOURCE_METADATA.json', source);
  put('BUILD_PROVENANCE.json', { formatVersion: 1, node: process.version, platform: 'linux', arch: process.arch, sourceManifestSha256: source.manifestSha256,
    artifacts: [...files].filter(([path]) => /\/dist\//.test(path)).map(([path, text]) => ({ path, sha256: sha(text) })) });
  put('RUNTIME_BUILD.json', { formatVersion: 1, packageFormat: 'mihomo-manager-runtime', product: 'mihomo-manager', version: '0.2.0',
    webuiUpdateProtocol: 1, node: process.version, platform: 'linux', arch: process.arch, components, source });
  mutate(files);
  put('RUNTIME_FILES_SHA256', [...files].map(([path, text]) => sha(text) + '  ./' + path + '\n').join(''));
  const payload = join(root, 'payload'); mkdirSync(payload);
  for (const [path, text] of files) { const target = join(payload, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text); }
  const archive = join(root, 'runtime.tar.gz');
  execFileSync('tar', ['--format=ustar', '-czf', archive, '-C', payload, '.']);
  return { root, archive, options: { platform: 'linux' } };
}

