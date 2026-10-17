import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ProxyNodeSettingsConflictError,
  ProxyNodeSettingsValidationError,
} from "../src/config/errors.ts";
import { ConfigStore } from "../src/config/store.ts";
import { ProxyNodeSettingsService, saveProxyNodeInfoUnqueued } from "../src/proxyNodeSettings/service.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

test("proxy node regions persist across clients and enforce version conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "mihomo-node-settings-"));
  const statePath = join(root, "proxy-node-settings.json");
  const first = new ProxyNodeSettingsService({ statePath });
  const second = new ProxyNodeSettingsService({ statePath });
  assert.deepEqual(await first.read(), { schemaVersion: 1, version: 0, regions: [] });
  const saved = await first.save({ expectedVersion: 0, regions: [{ provider: "source", name: "node", label: "Region" }] });
  assert.equal(saved.version, 1);
  assert.deepEqual((await second.read()).regions, saved.regions);
  await assert.rejects(
    second.save({ expectedVersion: 0, regions: [] }),
    ProxyNodeSettingsConflictError,
  );
});

test("proxy node regions reject invalid structures and retain the prior file on atomic failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "mihomo-node-settings-"));
  const statePath = join(root, "proxy-node-settings.json");
  let fail = false;
  const service = new ProxyNodeSettingsService({
    statePath,
    beforeRename: async () => { if (fail) throw new Error("injected failure"); },
  });
  await service.save({ expectedVersion: 0, regions: [{ provider: "", name: "node", label: "Region" }] });
  const previous = await readFile(statePath, "utf8");
  fail = true;
  await assert.rejects(service.save({ expectedVersion: 1, regions: [] }));
  assert.equal(await readFile(statePath, "utf8"), previous);
  await assert.rejects(
    service.save({ expectedVersion: 1, regions: [{ provider: "", name: "", label: "Region" }] }),
    ProxyNodeSettingsValidationError,
  );
  await assert.rejects(
    service.save({ expectedVersion: 1, regions: [
      { provider: "", name: "node", label: "A" },
      { provider: "", name: "node", label: "B" },
    ] }),
    ProxyNodeSettingsValidationError,
  );
});

test("proxy node region migration preserves the label and publishes one new version", async () => {
  const root = await mkdtemp(join(tmpdir(), "mihomo-node-settings-"));
  const service = new ProxyNodeSettingsService({ statePath: join(root, "proxy-node-settings.json") });
  await service.save({ expectedVersion: 0, regions: [{ provider: "", name: "old", label: "Region" }] });
  const migrated = await service.migrateRegionUnqueued({
    expectedVersion: 1,
    from: { provider: "", name: "old" },
    to: { provider: "", name: "new" },
    region: "Region",
  });
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.regions, [{ provider: "", name: "new", label: "Region" }]);
});

test("node info transaction validates config, migrates region, and rolls config back when settings fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "mihomo-node-info-"));
  const configPath = join(root, "fixture.yaml");
  const oldContent = "mode: rule\nproxies:\n  - name: old\n    type: ss\n";
  const newContent = oldContent.replace("name: old", "name: new");
  await writeFile(configPath, oldContent);
  let failSettings = false;
  const store = new ConfigStore({
    configPath,
    mihomoBinary: process.execPath,
    dataDir: root,
    validationTimeoutMs: 1000,
    maxContentBytes: 4096,
    validatorArgsPrefix: [join(fixtureDir, "validator.mjs"), join(root, "marker")],
  });
  const settingsService = new ProxyNodeSettingsService({
    statePath: join(root, "proxy-node-settings.json"),
    beforeRename: async () => { if (failSettings) throw new Error("injected settings failure"); },
  });
  await settingsService.save({ expectedVersion: 0, regions: [{ provider: "", name: "old", label: "Region" }] });
  const before = await store.read("fixture.yaml");
  const saved = await saveProxyNodeInfoUnqueued({
    store, settingsService, configName: "fixture.yaml", content: newContent,
    expectedSha256: before.sha256, expectedVersion: 1,
    from: { provider: "", name: "old" }, to: { provider: "", name: "new" }, region: "Region",
  });
  assert.equal(saved.config.content, newContent);
  assert.deepEqual(saved.settings.regions, [{ provider: "", name: "new", label: "Region" }]);

  failSettings = true;
  const published = await store.read("fixture.yaml");
  await assert.rejects(saveProxyNodeInfoUnqueued({
    store, settingsService, configName: "fixture.yaml", content: oldContent,
    expectedSha256: published.sha256, expectedVersion: 2,
    from: { provider: "", name: "new" }, to: { provider: "", name: "old" }, region: "Region",
  }));
  assert.equal((await store.read("fixture.yaml")).content, newContent);
  assert.deepEqual((await settingsService.read()).regions, [{ provider: "", name: "new", label: "Region" }]);
});
