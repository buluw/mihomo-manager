import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { chmod, cp, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fixture } from '../../../release/test/runtime-fixture.mjs';
import { runtimeArchiveHash } from '../../../release/package.mjs';
import { programIdentity, readableTree, recoverWebUi, switchWebUi } from '../webui-install.mjs';

async function assertReadable(path) {
  const info = await stat(path);
  assert.equal(info.mode & 0o777, info.isDirectory() ? 0o755 : 0o644, path);
  if (info.isDirectory()) for (const child of await readdir(path)) await assertReadable(join(path, child));
}

async function setup(t) {
  const old = fixture(t), next = fixture(t, files => {
    files.set('sysinfo/dist/index.js', 'new fixture\n');
    const proof = JSON.parse(files.get('BUILD_PROVENANCE.json'));
    proof.artifacts.find(item => item.path === 'sysinfo/dist/index.js').sha256 = createHash('sha256').update('new fixture\n').digest('hex');
    files.set('BUILD_PROVENANCE.json', JSON.stringify(proof));
  });
  const paths = { app: join(old.root, 'payload'), privateDirectory: join(old.root, 'private'),
    stateDirectory: join(old.root, 'status'), downloadDirectory: join(old.root, 'download') };
  for (const path of [paths.privateDirectory, paths.stateDirectory, paths.downloadDirectory]) await mkdir(path);
  await cp(next.archive, join(paths.downloadDirectory, 'candidate.tar.gz'));
  const calls = [], operations = { stop: async names => { calls.push(['stop', names]); }, start: async names => { calls.push(['start', names]); },
    coreIdentity: async () => 'core-pid-start', health: async () => true };
  return { paths, calls, operations, original: await programIdentity(paths.app), sha256: await runtimeArchiveHash(next.archive) };
}

test('independent installation and rollback change only affected manager services and runtime scopes', async t => {
  const f = await setup(t);
  const stop = f.operations.stop;
  f.operations.stop = async names => {
    assert.equal((await stat(join(f.paths.privateDirectory, 'transaction'))).mode & 0o777, 0o700);
    await stop(names);
  };
  await chmod(join(f.paths.app, 'sysinfo/dist'), 0o700);
  await writeFile(join(f.paths.app, 'sysinfo', 'source-kept.txt'), 'development source');
  let accepted = false;
  const result = await switchWebUi({ action: 'install', sha256: f.sha256, id: randomUUID() }, f.paths, f.operations, async () => { accepted = true; });
  assert.equal(accepted, true); assert.equal(result.phase, 'succeeded'); assert.deepEqual(result.services, ['sysinfo']);
  assert.equal(result.previous.sha256, f.original.sha256);
  await assertReadable(join(f.paths.privateDirectory, 'previous'));
  assert.equal(await readFile(join(f.paths.app, 'sysinfo', 'source-kept.txt'), 'utf8'), 'development source');
  assert.notEqual((await programIdentity(f.paths.app)).sha256, f.original.sha256);
  const back = await switchWebUi({ action: 'rollback', sha256: result.previous.sha256, id: randomUUID() }, f.paths, f.operations);
  assert.equal(back.phase, 'rolled-back'); assert.equal(back.error, null);
  assert.equal((await programIdentity(f.paths.app)).sha256, f.original.sha256);
  await assertReadable(join(f.paths.privateDirectory, 'previous'));
  assert.equal(existsSync(join(f.paths.privateDirectory, 'transaction.json')), false);
});

test('failed health restores the exact prior program and retains the previous slot', async t => {
  const f = await setup(t); let checks = 0;
  f.operations.health = async () => ++checks > 1;
  const result = await switchWebUi({ action: 'install', sha256: f.sha256, id: randomUUID() }, f.paths, f.operations);
  assert.equal(result.phase, 'rolled-back'); assert.equal(result.error, 'webui_startup_failed_restored');
  assert.equal((await programIdentity(f.paths.app)).sha256, f.original.sha256);
  assert.equal(result.previous, null); assert.equal(checks, 2);
});

test('candidate identity mismatch is rejected before stopping services', async t => {
  const f = await setup(t);
  const result = await switchWebUi({ action: 'install', sha256: 'f'.repeat(64), id: randomUUID() }, f.paths, f.operations);
  assert.equal(result.phase, 'failed'); assert.equal(result.error, 'candidate_changed'); assert.deepEqual(f.calls, []);
  assert.equal((await programIdentity(f.paths.app)).sha256, f.original.sha256);
});

test('recovery resolves preparation and completes a committed previous-image rotation', async t => {
  const f = await setup(t), transaction = join(f.paths.privateDirectory, 'transaction');
  await mkdir(transaction); await writeFile(join(f.paths.privateDirectory, 'transaction.json'), JSON.stringify({
    phase: 'preparing', changes: [], services: [], status: { busy: true, previous: null }, core: null,
  }));
  assert.equal((await recoverWebUi(f.paths, f.operations)).phase, 'failed'); assert.deepEqual(f.calls, []);
  await mkdir(transaction); await cp(f.paths.app, join(transaction, 'old-image'), { recursive: true });
  const status = { phase: 'succeeded', busy: false, previous: f.original };
  await writeFile(join(f.paths.privateDirectory, 'transaction.json'), JSON.stringify({ phase: 'committed', changes: [], services: [], status }));
  await rename(join(transaction, 'old-image'), join(f.paths.privateDirectory, 'previous'));
  await chmod(join(f.paths.privateDirectory, 'previous'), 0o700);
  assert.deepEqual(await recoverWebUi(f.paths, f.operations), status);
  assert.equal(JSON.parse(await readFile(join(f.paths.stateDirectory, 'status.json'), 'utf8')).busy, false);
  assert.equal((await programIdentity(join(f.paths.privateDirectory, 'previous'))).sha256, f.original.sha256);
  await assertReadable(join(f.paths.privateDirectory, 'previous'));
});

test('deployment repairs readable backup trees including nested directories', async t => {
  const f = await setup(t), previous = join(f.paths.privateDirectory, 'previous');
  await cp(f.paths.app, previous, { recursive: true });
  await mkdir(join(previous, 'frontend/dist/new/nested'), { recursive: true, mode: 0o700 });
  await writeFile(join(previous, 'frontend/dist/new/nested/asset.js'), 'fixture', { mode: 0o600 });
  await chmod(previous, 0o700);
  await readableTree(previous);
  await assertReadable(previous);
});
