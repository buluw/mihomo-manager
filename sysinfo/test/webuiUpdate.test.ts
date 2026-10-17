import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compareWebUiVersions, queryWebUiRelease, webUiRelease } from '../src/webuiUpdate/release.js';
import { WebUiUpdates } from '../src/webuiUpdate/service.js';
import { AutomaticUpdates, defaultUpdatePolicy, nextInstallTime } from '../src/webuiUpdate/policy.js';
import { defaultInstallState } from '../src/webuiUpdate/control.js';
import { UpdateStore } from '../src/webuiUpdate/store.js';

const release = { tag_name: 'v0.3.0', body: 'Real release notes', assets: [{ name: 'mihomo-manager-v0.3.0-linux-x64.tar.gz', size: 10,
  digest: 'sha256:' + 'a'.repeat(64), browser_download_url: 'https://github.com/buluw/mihomo-manager/releases/download/v0.3.0/mihomo-manager-v0.3.0-linux-x64.tar.gz' }] };
async function directory(t: { after: (fn: () => Promise<void>) => void }) {
  const path = await mkdtemp(join(tmpdir(), 'webui-state-')); t.after(() => rm(path, { recursive: true, force: true })); return path;
}
test('release query distinguishes unpublished, usable versions, permissions, parsing and missing assets', async () => {
  assert.equal(compareWebUiVersions('v0.3.0', '0.2.0'), 1); assert.equal(compareWebUiVersions('0.2.0', '0.2.0'), 0);
  assert.equal(compareWebUiVersions('unknown', '0.2.0'), null);
  for (const [status, code] of [[403, 'webui_release_forbidden'], [503, 'webui_release_unavailable'], [200, 'webui_invalid_release']] as const) {
    await assert.rejects(queryWebUiRelease(null, async () => ({ status, body: Buffer.from('invalid') })), { code });
  }
  assert.equal(await queryWebUiRelease(null, async () => ({ status: 404, body: Buffer.alloc(0) })), null);
  assert.equal(webUiRelease(release).releaseNotes, 'Real release notes');
  assert.throws(() => webUiRelease({ ...release, assets: [] }), { code: 'webui_asset_unavailable' });
});
test('manual job state survives restart, excludes overlap and does not persist credentials', async t => {
  const path = await directory(t); let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const dependencies = { proxyFor: async () => null, query: async () => { await wait; return null; }, readInstaller: async () => ({ ...defaultInstallState }) };
  const updates = new WebUiUpdates(path, dependencies); await updates.initialize({ version: '0.2.0', sourceSha256: null });
  const pending = updates.startCheck({ mode: 'external', proxy: 'http://user:password@example.test:8888' });
  assert.throws(() => updates.startCheck({ mode: 'direct' }), { code: 'webui_action_busy' });
  finish(); await pending;
  assert.equal((await updates.status()).checkState, 'unpublished');
  const saved = await readFile(join(path, 'state.json'), 'utf8'); assert.equal(saved.includes('password'), false);
  const restored = new WebUiUpdates(path, dependencies); await restored.initialize({ version: '0.2.0', sourceSha256: null });
  assert.equal((await restored.status()).checkState, 'unpublished');
});
test('upload validation binds candidates and changed archive blocks install', async t => {
  const path = await directory(t);
  const info = { version: '0.2.0', sha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64), revision: 'c'.repeat(40), dirty: true, protocol: 1,
    fileCount: 10, node: process.version, arch: process.arch, platform: 'linux' };
  let controls = 0;
  const updates = new WebUiUpdates(path, { validate: async () => info, readInstaller: async () => ({ ...defaultInstallState }), control: async () => { controls++; } });
  await updates.initialize({ version: '0.2.0', sourceSha256: null });
  await updates.receiveUpload((async function* () { yield Buffer.from('fixture'); })(), 7);
  assert.equal((await updates.status()).phase, 'ready');
  assert.throws(() => updates.startInstall('f'.repeat(64)), { code: 'candidate_changed' });
  await writeFile(join(path, 'candidate.tar.gz'), 'changed'); await updates.startInstall(info.sha256);
  assert.equal((await updates.status()).error, 'candidate_changed'); assert.equal(controls, 0);
});
test('persistent policy runs checks and scheduled installs, saves revisions, and remains idle when off', async t => {
  const path = await directory(t); let now = new Date(2026, 9, 17, 2, 0).getTime(); const calls: string[] = [];
  const state = { checkState: 'succeeded', latest: { version: '0.3.0' }, current: { version: '0.2.0' }, candidate: null as null | { version: string; verification: string; sha256: string }, error: null };
  const webui = { directory: path, assertIdle: async () => {}, startCheck: async () => { calls.push('webui-check'); }, status: async () => state,
    startDownload: async () => { calls.push('download'); state.candidate = { version: '0.3.0', verification: 'official', sha256: 'a'.repeat(64) }; },
    startInstall: async () => { calls.push('install'); } } as unknown as WebUiUpdates;
  const core = { busy: false, checkAutomatically: async () => { calls.push('core-check'); } };
  const policy = new AutomaticUpdates(webui, core, path, () => now); await policy.initialize();
  await policy.tick(); assert.deepEqual(calls, []);
  await assert.rejects(policy.save({ ...defaultUpdatePolicy(), mode: 'external' }, 0), { code: 'webui_invalid_policy' });
  await policy.save({ ...defaultUpdatePolicy(), autoCheck: true, autoDownload: true, scheduledInstall: true }, 0);
  await assert.rejects(policy.save(defaultUpdatePolicy(), 0), { code: 'webui_policy_changed' });
  await policy.tick(); assert.deepEqual(calls, ['core-check', 'webui-check', 'download']);
  const saved = await stat(join(path, 'policy.json')); await policy.tick(); assert.equal((await stat(join(path, 'policy.json'))).mtimeMs, saved.mtimeMs);
  now = nextInstallTime(now, '03:00'); await policy.tick(); assert.equal(calls.at(-1), 'install');
  const restored = new AutomaticUpdates(webui, core, path, () => now); await restored.initialize();
  assert.equal(restored.status().settings.autoDownload, true); assert.equal(restored.status().timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  await restored.save(defaultUpdatePolicy(), 1); await restored.tick(); assert.equal(calls.filter(call => call === 'install').length, 1);
  core.busy = true; await restored.tick(); assert.equal(restored.status().running, false);
});
test('changing policy during an automatic check prevents its later download', async t => {
  const path = await directory(t); let finish!: () => void, downloaded = false;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const webui = { directory: path, assertIdle: async () => {}, startCheck: async () => {}, startDownload: async () => { downloaded = true; } } as unknown as WebUiUpdates;
  const policy = new AutomaticUpdates(webui, { busy: false, checkAutomatically: () => waiting }, path);
  await policy.initialize(); await policy.save({ ...defaultUpdatePolicy(), autoCheck: true, autoDownload: true }, 0);
  const tick = policy.tick(); await new Promise(resolve => setImmediate(resolve)); await policy.save(defaultUpdatePolicy(), 1);
  finish(); await tick; assert.equal(downloaded, false); assert.equal(policy.status().settings.autoCheck, false);
});

for (const stage of ['candidate', 'idle', 'persist'] as const) {
  for (const cancel of ['disable', 'dispose', 'restart'] as const) {
    test('scheduled install cancels at ' + stage + ' after ' + cancel, { timeout: 5000 }, async t => {
      const path = await directory(t);
      let now = new Date(2026, 9, 17, 2, 0).getTime(), installs = 0, idleCalls = 0;
      let reached!: () => void, release!: () => void;
      const paused = new Promise<void>(resolve => { reached = resolve; });
      const waiting = new Promise<void>(resolve => { release = resolve; });
      const pause = async () => { reached(); await waiting; };
      const webui = { directory: path,
        assertIdle: async () => { if (++idleCalls === 2 && stage === 'idle') await pause(); },
        status: async () => {
          if (stage === 'candidate') await pause();
          return { current: { version: '0.2.0' }, candidate: { version: '0.3.0', verification: 'official', sha256: 'a'.repeat(64) } };
        },
        startInstall: async () => { installs++; },
      } as unknown as WebUiUpdates;
      const policy = new AutomaticUpdates(webui, { busy: false, checkAutomatically: async () => {} }, path, () => now);
      await policy.initialize();
      await policy.save({ ...defaultUpdatePolicy(), scheduledInstall: true }, 0);
      now = nextInstallTime(now, '03:00');
      const write = UpdateStore.prototype.write;
      let intercepted = false;
      t.mock.method(UpdateStore.prototype, 'write', async function (this: UpdateStore, value: unknown) {
        await write.call(this, value);
        if (stage === 'persist' && this.path === join(path, 'policy.json') && !intercepted && (value as { lastInstallAt: unknown }).lastInstallAt) {
          intercepted = true; await pause();
        }
      });
      const pending = policy.tick();
      try {
        await paused;
        if (cancel === 'disable') await policy.save(defaultUpdatePolicy(), 1);
        else { policy.dispose(); if (cancel === 'restart') policy.start(); }
        release(); await pending;
        assert.equal(installs, 0);
        assert.equal(policy.status().lastInstallAt, null);
        const restored = new AutomaticUpdates(webui, { busy: false, checkAutomatically: async () => {} }, path, () => now);
        await restored.initialize();
        assert.equal(restored.status().lastInstallAt, null);
        assert.equal(restored.status().settings.scheduledInstall, cancel !== 'disable');
        assert.equal(policy.status().running, false);
      } finally { release(); policy.dispose(); await pending; }
    });
  }
}
