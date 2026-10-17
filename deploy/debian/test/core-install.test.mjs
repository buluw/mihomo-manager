import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { switchCore } from '../core-install.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'core-install-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = { binary: join(directory, 'core'), candidate: join(directory, 'candidate'), manifest: join(directory, 'candidate.json') };
  await writeFile(paths.binary, 'old'); await writeFile(paths.candidate, 'new');
  await writeFile(paths.manifest, JSON.stringify({ sha256: createHash('sha256').update('new').digest('hex') }));
  const calls = [];
  const operations = {
    own: async () => {},
    probe: async path => ({ version: await readFile(path, 'utf8') }),
    validate: async () => { calls.push('validate'); },
    stop: async () => { calls.push('stop'); },
    start: async () => { calls.push('start'); },
    ready: async expected => { calls.push('ready:' + expected.version); return true; },
  };
  return { paths, operations, calls };
}

test('install verifies before stopping and retains local previous; manual rollback needs no candidate or network', async t => {
  const { paths, operations, calls } = await fixture(t);
  assert.equal(await switchCore('install', paths, operations), 'ok');
  assert.deepEqual(calls, ['validate', 'stop', 'start', 'ready:new']);
  assert.equal(await readFile(paths.binary, 'utf8'), 'new');
  assert.equal(await readFile(paths.binary + '.previous', 'utf8'), 'old');
  await rm(paths.candidate); await rm(paths.manifest);
  assert.equal(await switchCore('rollback', paths, operations), 'ok');
  assert.equal(await readFile(paths.binary, 'utf8'), 'old');
  assert.equal(await readFile(paths.binary + '.previous', 'utf8'), 'new');
});

test('failed new startup restores old and confirms it, preserving previous usable backup', async t => {
  const { paths, operations, calls } = await fixture(t);
  await writeFile(paths.binary + '.previous', 'earlier');
  operations.ready = async expected => { calls.push('ready:' + expected.version); return expected.version === 'old'; };
  assert.equal(await switchCore('install', paths, operations), 'rolled_back');
  assert.equal(await readFile(paths.binary, 'utf8'), 'old');
  assert.equal(await readFile(paths.binary + '.previous', 'utf8'), 'earlier');
  assert.deepEqual(calls, ['validate', 'stop', 'start', 'ready:new', 'stop', 'start', 'ready:old']);
});

test('checksum and compatibility rejection never stop old Core', async t => {
  const { paths, operations, calls } = await fixture(t);
  await writeFile(paths.candidate, 'tampered');
  assert.equal(await switchCore('install', paths, operations), 'failed');
  assert.deepEqual(calls, []);
  await writeFile(paths.candidate, 'new');
  operations.validate = async () => { throw new Error('not compatible'); };
  assert.equal(await switchCore('install', paths, operations), 'failed');
  assert.deepEqual(calls, []);
  assert.equal(await readFile(paths.binary, 'utf8'), 'old');
});

test('streamed copies preserve multichunk bytes and reject oversized or symlink candidates before stopping', async t => {
  const { paths, operations, calls } = await fixture(t);
  const content = Buffer.alloc(1024 * 1024 + 13, 42);
  await writeFile(paths.candidate, content);
  await writeFile(paths.manifest, JSON.stringify({ sha256: createHash('sha256').update(content).digest('hex') }));
  assert.equal(await switchCore('install', paths, operations), 'ok');
  assert.deepEqual(await readFile(paths.binary), content);
  calls.length = 0;
  await truncate(paths.candidate, 128 * 1024 * 1024 + 1);
  assert.equal(await switchCore('install', paths, operations), 'failed');
  assert.deepEqual(calls, []);
  await rm(paths.candidate);
  await symlink(paths.binary, paths.candidate);
  assert.equal(await switchCore('install', paths, operations), 'failed');
  assert.deepEqual(calls, []);
  await assert.rejects(readFile(paths.binary + '.next'), { code: 'ENOENT' });
});

test('unconfirmed rollback is not success and retains a local recovery file', async t => {
  const { paths, operations } = await fixture(t);
  operations.ready = async () => false;
  assert.equal(await switchCore('install', paths, operations), 'failed');
  assert.equal(await readFile(paths.binary, 'utf8'), 'old');
  assert.equal(await readFile(paths.binary + '.recovery', 'utf8'), 'old');
});

test('manual rollback after an unconfirmed restore succeeds and later installation can continue', async t => {
  const { paths, operations } = await fixture(t);
  await writeFile(paths.binary + '.previous', 'earlier');
  operations.ready = async () => false;
  assert.equal(await switchCore('install', paths, operations), 'failed');
  assert.equal(await readFile(paths.binary + '.recovery', 'utf8'), 'old');
  assert.equal(await readFile(paths.binary + '.previous', 'utf8'), 'earlier');

  operations.ready = async () => true;
  assert.equal(await switchCore('rollback', paths, operations), 'ok');
  assert.equal(await readFile(paths.binary, 'utf8'), 'earlier');
  assert.equal(await readFile(paths.binary + '.previous', 'utf8'), 'old');
  await assert.rejects(readFile(paths.binary + '.recovery'), { code: 'ENOENT' });

  assert.equal(await switchCore('install', paths, operations), 'ok');
  assert.equal(await readFile(paths.binary, 'utf8'), 'new');
  assert.equal(await readFile(paths.binary + '.previous', 'utf8'), 'earlier');
  await assert.rejects(readFile(paths.binary + '.recovery'), { code: 'ENOENT' });
});

test('retained recovery survives validation failure and is reused instead of an unconfirmed current file', async t => {
  const { paths, operations, calls } = await fixture(t);
  await writeFile(paths.binary, 'unconfirmed');
  await writeFile(paths.binary + '.recovery', 'old');
  await writeFile(paths.binary + '.previous', 'earlier');
  const validate = operations.validate;
  operations.validate = async () => { throw new Error('not compatible'); };
  assert.equal(await switchCore('install', paths, operations), 'failed');
  assert.deepEqual(calls, []);
  assert.equal(await readFile(paths.binary + '.recovery', 'utf8'), 'old');
  assert.equal(await readFile(paths.binary, 'utf8'), 'unconfirmed');
  assert.equal(await readFile(paths.binary + '.previous', 'utf8'), 'earlier');

  operations.validate = validate;
  operations.ready = async expected => { calls.push('ready:' + expected.version); return expected.version === 'old'; };
  assert.equal(await switchCore('install', paths, operations), 'rolled_back');
  assert.deepEqual(calls, ['validate', 'stop', 'start', 'ready:new', 'stop', 'start', 'ready:old']);
  assert.equal(await readFile(paths.binary, 'utf8'), 'old');
  assert.equal(await readFile(paths.binary + '.previous', 'utf8'), 'earlier');
  await assert.rejects(readFile(paths.binary + '.recovery'), { code: 'ENOENT' });
});
