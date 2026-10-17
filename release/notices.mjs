import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonFile, projectRoot, sha256, writeJson } from './source.mjs';

const noticeName = /^(licen[cs]e|copying|notice|ofl|thirdpartynotices)([.-].*)?$/i;

export function collectNotices(root) {
  const entries = new Map(), lockfiles = {}, missing = [];
  for (const component of ['frontend', 'configd', 'logd', 'sysinfo']) {
    const lockPath = resolve(root, component, 'package-lock.json');
    const lock = jsonFile(lockPath);
    lockfiles[component] = sha256(readFileSync(lockPath));
    for (const [path, record] of Object.entries(lock.packages)) {
      if (!path) continue;
      const directory = resolve(root, component, path);
      if (!existsSync(resolve(directory, 'package.json'))) {
        if (!record.optional) missing.push(component + '/' + path);
        continue;
      }
      const pkg = jsonFile(resolve(directory, 'package.json'));
      if (pkg.version !== record.version) throw new Error('Installed dependency differs from lock: ' + path);
      const key = pkg.name + '@' + pkg.version;
      if (entries.has(key)) { entries.get(key).components.push(component); continue; }
      let files = readdirSync(directory).filter(name => noticeName.test(name) && statSync(resolve(directory, name)).isFile())
        .sort().map(name => ({ name, text: readFileSync(resolve(directory, name), 'utf8').replaceAll('\r', '') }));
      let noticeSource = 'installed package';
      if (!files.length && (pkg.name.startsWith('@esbuild/') || pkg.name.startsWith('@rollup/'))) {
        const parent = pkg.name.startsWith('@esbuild/') ? 'esbuild' : 'rollup';
        const parentDirectory = resolve(root, component, 'node_modules', parent);
        const parentPackage = jsonFile(resolve(parentDirectory, 'package.json'));
        if (parentPackage.version !== pkg.version) throw new Error('Native dependency license parent differs.');
        files = readdirSync(parentDirectory).filter(name => noticeName.test(name) && statSync(resolve(parentDirectory, name)).isFile())
          .sort().map(name => ({ name, text: readFileSync(resolve(parentDirectory, name), 'utf8').replaceAll('\r', '') }));
        noticeSource = parent + '@' + parentPackage.version;
      }
      if (!files.length && key === 'size-sensor@1.0.3') {
        files = [{ name: 'upstream-notice', text: readFileSync(resolve(root, 'licenses/size-sensor.txt'), 'utf8') }];
        noticeSource = 'pinned upstream README and declared ISC terms';
      }
      if (!files.length) throw new Error('Dependency license text needs review: ' + key);
      const license = typeof pkg.license === 'string' ? pkg.license : record.license;
      if (!license) throw new Error('Dependency license declaration needs review: ' + key);
      entries.set(key, { name: pkg.name, version: pkg.version, license, components: [component], noticeSource, files });
    }
  }
  if (missing.length) throw new Error('Install locked dependencies before collecting notices: ' + missing.join(', '));
  const packages = [...entries.values()].sort((a, b) => (a.name + '@' + a.version).localeCompare(b.name + '@' + b.version, 'en'));
  const header = 'Mihomo Manager third-party license texts\n\nThis inventory covers installed runtime and build dependencies from the locked Linux build. Each dependency retains its own license. Platform-specific optional packages are listed when installed.\n';
  const text = header + packages.map(pkg => '\n========================================\n' + pkg.name + '@' + pkg.version + '\nDeclared license: ' + pkg.license
    + '\nComponents: ' + pkg.components.join(', ') + '\nNotice source: ' + pkg.noticeSource + '\n\n'
    + pkg.files.map(file => '--- ' + file.name + ' ---\n' + file.text.trimEnd() + '\n').join('\n')).join('');
  writeFileSync(resolve(root, 'THIRD_PARTY_LICENSES.txt'), text);
  const inventory = { formatVersion: 1, lockfiles, packages: packages.map(({ files, ...pkg }) => ({ ...pkg,
    notices: files.map(file => ({ name: file.name, sha256: sha256(file.text) })) })), noticesSha256: sha256(text) };
  writeJson(resolve(root, 'release/dependencies.json'), inventory);
  return { packages: packages.length, licenses: [...new Set(packages.map(pkg => pkg.license))].sort(), noticesSha256: inventory.noticesSha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(collectNotices(projectRoot)));
