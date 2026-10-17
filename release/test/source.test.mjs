import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportSource, publicFiles, sha256, sourceIdentity } from '../source.mjs';

function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'mihomo-public-test-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'worktree'); mkdirSync(root);
  const files = [];
  for (const component of ['frontend', 'configd', 'logd', 'sysinfo']) {
    mkdirSync(join(root, component));
    const path = component + '/package.json'; files.push(path);
    writeFileSync(join(root, path), JSON.stringify({ name: component, version: '0.2.0' }));
  }
  mkdirSync(join(root, 'release')); files.push('release/public-files.json');
  writeFileSync(join(root, 'release/public-files.json'), JSON.stringify({ formatVersion: 1, files }));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
  return { parent, root, files };
}

test('public export captures dirty source bytes and excludes local files', t => {
  const { parent, root } = fixture(t);
  writeFileSync(join(root, 'frontend/package.json'), JSON.stringify({ name: 'web', version: '0.2.0' }));
  mkdirSync(join(root, '.agent')); writeFileSync(join(root, '.agent/private.txt'), 'local fixture');
  const output = join(parent, 'snapshot');
  const result = exportSource(root, output);
  assert.equal(result.dirty, true);
  assert.match(result.revision, /^[a-f0-9]{40}$/);
  assert.equal(result.manifestSha256, sha256(readFileSync(join(output, 'SOURCE_FILES_SHA256'))));
  assert.equal(readFileSync(join(output, 'frontend/package.json'), 'utf8'), readFileSync(join(root, 'frontend/package.json'), 'utf8'));
  assert.equal(existsSync(join(output, '.agent')), false);
  assert.throws(() => exportSource(root, output), /must be new/);
  assert.throws(() => exportSource(root, join(root, 'output')), /outside/);
  assert.equal(existsSync(join(root, '.agent/private.txt')), true);
});

test('public list rejects traversal and protected file categories', t => {
  const { root } = fixture(t);
  for (const file of ['../private', '.agent/private', 'frontend/.env', 'frontend/dist/app.js', 'ssh/key', 'test/ui-preview/index.html']) {
    assert.throws(() => publicFiles(root, { formatVersion: 1, files: [file] }), /excluded/);
  }
});

test('exported snapshots preserve source identity when exported again', t => {
  const { parent, root } = fixture(t);
  const first = join(parent, 'first'), second = join(parent, 'second');
  const identity = exportSource(root, first);
  assert.deepEqual(exportSource(first, second), identity);
});

test('formal source binds a clean version-tagged commit and survives archive export', t => {
  const { parent, root } = fixture(t);
  const files = publicFiles(root);
  assert.throws(() => sourceIdentity(root, files, { release: true }), /matching version tag/);
  execFileSync('git', ['-C', root, 'tag', 'v0.2.0']);
  const identity = sourceIdentity(root, files, { release: true });
  assert.equal(identity.metadata.status, 'release'); assert.equal(identity.metadata.tag, 'v0.2.0');
  assert.equal(identity.metadata.dirty, false);
  assert.equal(identity.metadata.revision, execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  const snapshot = join(parent, 'release-source');
  assert.deepEqual(exportSource(root, snapshot, { release: true }), identity.metadata);
  assert.deepEqual(sourceIdentity(snapshot, publicFiles(snapshot), { release: true }), identity);
  writeFileSync(join(snapshot, 'frontend/package.json'), JSON.stringify({ name: 'changed', version: '0.2.0' }));
  assert.throws(() => sourceIdentity(snapshot, publicFiles(snapshot), { release: true }), /must be clean/);
  writeFileSync(join(root, 'uncommitted.txt'), 'fixture');
  assert.throws(() => sourceIdentity(root, files, { release: true }), /must be clean/);
  assert.equal(sourceIdentity(root, files).metadata.status, 'candidate');
});

test('candidate exports retain their recorded release qualification', t => {
  const { parent, root } = fixture(t);
  const snapshot = join(parent, 'candidate'); exportSource(root, snapshot);
  assert.throws(() => sourceIdentity(snapshot, publicFiles(snapshot), { release: true }), /matching release metadata/);
});
