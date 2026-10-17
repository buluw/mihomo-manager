import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { validateRuntimePackage } from '../package.mjs';

import { fixture } from './runtime-fixture.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
test('valid runtime package binds the archive, source and compiled file identities', async t => {
  const f = fixture(t);
  const result = await validateRuntimePackage(f.archive, join(f.root, 'checked'), { ...f.options, expectedVersion: 'v0.2.0' });
  assert.equal(result.version, '0.2.0'); assert.equal(result.protocol, 1);
  assert.equal(result.sha256, sha(readFileSync(f.archive)));
  assert.equal(result.dirty, true);
});

test('runtime package rejects environment, protocol and component identity changes', async t => {
  for (const [field, value, code] of [['node', 'v0.0.0', 'webui_environment_mismatch'], ['webuiUpdateProtocol', 0, 'webui_package_unsupported']]) {
    const f = fixture(t, files => { const meta = JSON.parse(files.get('RUNTIME_BUILD.json')); meta[field] = value; files.set('RUNTIME_BUILD.json', JSON.stringify(meta)); });
    await assert.rejects(validateRuntimePackage(f.archive, join(f.root, 'checked'), f.options), { code });
    assert.equal(existsSync(join(f.root, 'checked')), false);
  }
  const f = fixture(t, files => files.set('sysinfo/package.json', JSON.stringify({ version: '9.0.0' })));
  await assert.rejects(validateRuntimePackage(f.archive, join(f.root, 'checked'), f.options), { code: 'version_mismatch' });
});

test('runtime package rejects an altered compiled artifact and an unexpected archive digest', async t => {
  const f = fixture(t, files => files.set('sysinfo/dist/index.js', 'changed after build\n'));
  await assert.rejects(validateRuntimePackage(f.archive, join(f.root, 'checked'), f.options), { code: 'checksum_mismatch' });
  await assert.rejects(validateRuntimePackage(f.archive, join(f.root, 'checked'), { ...f.options, expectedSha256: '0'.repeat(64) }), { code: 'checksum_mismatch' });
});

test('tar extraction rejects parent traversal and links before creating outside files', async t => {
  const root = mkdtempSync(join(tmpdir(), 'webui-tar-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, type] of [['../outside', '0'], ['frontend/link', '2']]) {
    const header = Buffer.alloc(512);
    header.write(name, 0); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write('00000000000\0', 124); header.write('00000000000\0', 136); header.fill(32, 148, 156);
    header.write(type, 156); header.write('ustar\0', 257); header.write('00', 263);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    const archive = join(root, 'bad.tar.gz'); writeFileSync(archive, gzipSync(Buffer.concat([header, Buffer.alloc(1024)])));
    await assert.rejects(validateRuntimePackage(archive, join(root, 'checked'), { platform: 'linux' }), { code: 'webui_invalid_package' });
    assert.equal(existsSync(join(root, 'outside')), false);
  }
});
