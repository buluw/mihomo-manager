import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Diagnostic-only workload: package directory is read, all data lives in mkdtemp.
const packageRoot = resolve(process.argv[2]);
const load = path => import(pathToFileURL(join(packageRoot, 'dist', path)).href);
const { ConfigStore } = await load('config/store.js');
const { ProviderFileService } = await load('providerFiles/service.js');
const { ManagerSettingsService } = await load('managerSettings/service.js');
const { WriteQueue } = await load('writeQueue.js');
assert.equal(typeof global.gc, 'function', 'Run this isolated diagnostic with --expose-gc');
const root = await mkdtemp(join(tmpdir(), 'mihomo-collection-memory-'));
const pad = (text, bytes) => text + (text.length + 3 < bytes ? '# ' + 'x'.repeat(bytes - text.length - 3) + '\n' : '');
const counts = { read: 0, list: 0 };
const memory = () => process.memoryUsage();
const delta = before => ({ read: counts.read - before.read, list: counts.list - before.list });
const elapsed = start => Number((performance.now() - start).toFixed(3));
try {
  await mkdir(join(root, 'configs'));
  await mkdir(join(root, 'providers'));
  await mkdir(join(root, 'ruleset'));
  const bodyBytes = [1979, 1709, 5939, 3599, 1799];
  for (let index = 0; index < bodyBytes.length; index++) {
    const content = pad('proxies:\n' + Array.from({ length: [9, 8, 28, 17, 8][index] }, (_, row) =>
      '  - {name: node-' + index + '-' + row + ', type: socks5, server: 127.0.0.1, port: ' + (10000 + row) + '}\n').join(''), bodyBytes[index]);
    assert.equal(Buffer.byteLength(content), bodyBytes[index]);
    await writeFile(join(root, 'providers/p' + index + '.yaml'), content);
  }
  const sourceText = pad('mode: rule\nproxy-providers:\n' + Array.from({ length: 5 }, (_, index) =>
    '  p' + index + ': {type: file, path: ./providers/p' + index + '.yaml}\n').join('') +
    'rule-providers:\n' + Array.from({ length: 16 }, (_, index) =>
      '  r' + index + ': {type: http, behavior: classical, format: yaml, url: http://127.0.0.1:1/r' + index + ', path: ./ruleset/r' + index + '.yaml, interval: 86400}\n').join('') +
    '  local: {type: inline, behavior: classical, payload: [' + Array.from({ length: 20 }, (_, index) => '"DOMAIN,inline' + index + '.invalid"').join(', ') + ']}\n' +
    'proxy-groups:\n' + Array.from({ length: 24 }, (_, index) =>
      '  - {name: Group' + index + ', type: select, proxies: [DIRECT, REJECT], use: [p0, p1, p2, p3, p4]}\n').join('') +
    'rules:\n' + Array.from({ length: 42 }, (_, index) => '  - DOMAIN,fixture' + index + '.invalid,Group' + (index % 24) + '\n').join('') + '  - MATCH,DIRECT\n', 7849);
  await writeFile(join(root, 'configs/main.yaml'), sourceText);
  await writeFile(join(root, 'configs/empty.yaml'), '');
  const queue = new WriteQueue();
  const store = new ConfigStore({ configPath: join(root, 'configs/main.yaml'), dataDir: root,
    mihomoBinary: process.execPath, validatorArgsPrefix: ['-e', 'process.exit(0)', '--'],
    validationTimeoutMs: 5000, maxContentBytes: 8 * 1024 * 1024, writeQueue: queue });
  const read = store.read.bind(store), list = store.list.bind(store);
  store.read = (...args) => { counts.read++; return read(...args); };
  store.list = (...args) => { counts.list++; return list(...args); };
  const providers = new ProviderFileService({ providerDir: join(root, 'providers'), ruleProviderDir: join(root, 'ruleset'),
    statePath: join(root, 'providers.json'), dataDir: root, store, writeQueue: queue, maxContentBytes: 8 * 1024 * 1024 });
  const settings = new ManagerSettingsService({ statePath: join(root, 'settings.json'), runtimeDir: join(root, 'runtime'), store, writeQueue: queue });
  await providers.init();
  global.gc();
  const initial = memory(), preparationCounts = { ...counts }, rounds = [];
  const start = performance.now();
  let naturalBeforeGc, naturalAfterGc;
  for (let iteration = 0; iteration < 18; iteration++) {
    const roundStart = performance.now(), before = { ...counts };
    const fileName = 'p' + (iteration % 5) + '.yaml';
    const file = await providers.read('proxy', fileName);
    await providers.save('proxy', fileName, file.content + '# round ' + iteration + '\n', file.sha256);
    const source = await store.read('main.yaml');
    const saved = await store.saveFile(source.name, source.content + '# round ' + iteration + '\n', source.sha256);
    const beforeGenerate = { ...counts }, generationStart = performance.now();
    const generated = await settings.generate({ sourceName: saved.name, expectedSourceSha256: saved.sha256, expectedSettingsVersion: 0 }, async (name, sha) => {
      await providers.regenerateLocalExtractionsForConfigUnqueued(name, sha);
      await providers.validateSourceCollectionsUnqueued(name, sha);
    });
    const generation = { ...delta(beforeGenerate), ms: elapsed(generationStart) };
    assert.equal(generated.sourceSha256, saved.sha256);
    assert.equal((await providers.list()).length, 5);
    assert.equal((await store.read('main.yaml')).sha256, saved.sha256);
    const beforeGc = memory();
    if (iteration >= 11) global.gc();
    if (iteration === 11) { naturalBeforeGc = beforeGc; naturalAfterGc = memory(); }
    rounds.push({ iteration: iteration + 1, operations: delta(before), generation, ms: elapsed(roundStart), beforeGc, afterGc: iteration >= 11 ? memory() : null });
  }
  console.log(JSON.stringify({ workload: { sourceBytes: Buffer.byteLength(sourceText), bodyBytes, fileCollections: 5, httpDeclarations: 16, inlineRules: 20, selectGroups: 24, rules: 43, rounds: 18 },
    diagnosticGcOnly: true, preparationCounts, counts, elapsedMs: elapsed(start), initial, naturalBeforeGc, naturalAfterGc, final: memory(), rounds }));
} finally { await rm(root, { recursive: true, force: true }); }
