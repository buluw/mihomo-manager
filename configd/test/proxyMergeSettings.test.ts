import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ConfigStore } from "../src/config/store.ts";
import {
  ProxyMergeSettingsConflictError,
  ProxyMergeSettingsValidationError,
} from "../src/config/errors.ts";
import { ProxyMergeSettingsService } from "../src/proxyMergeSettings/service.ts";
import { createConfigdServer } from "../src/server.ts";

const firstGroup = {
  id: "group-1",
  displayName: "Machine A",
  source: "manual" as const,
  members: [
    { provider: "provider-a", name: "node-a" },
    { provider: "provider-a", name: "node-b" },
  ],
};

test("proxy merge settings persist versions and reject stale or invalid writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mihomo-merge-settings-"));
  const service = new ProxyMergeSettingsService({ statePath: join(root, "proxy-merge-settings.json") });
  assert.deepEqual(await service.read(), { schemaVersion: 1, version: 0, groups: [], exclusions: [] });

  const created = await service.save({ expectedVersion: 0, groups: [firstGroup], exclusions: [] });
  assert.equal(created.version, 1);
  assert.deepEqual((await service.read()).groups, [firstGroup]);

  const updated = await service.save({
    expectedVersion: 1,
    groups: [{ ...firstGroup, displayName: "" }],
    exclusions: [{ provider: "provider-b", name: "node-c" }],
  });
  assert.equal(updated.version, 2);
  assert.equal((await service.read()).groups[0]?.displayName, "");
  await assert.rejects(
    service.save({ expectedVersion: 1, groups: [firstGroup], exclusions: [] }),
    ProxyMergeSettingsConflictError,
  );
  assert.throws(
    () => service.save({
      expectedVersion: 2,
      groups: [{ ...firstGroup, members: [firstGroup.members[0]!] }],
      exclusions: [],
    }),
    ProxyMergeSettingsValidationError,
  );
  assert.equal((await service.read()).version, 2);
});

test("proxy merge settings keep the previous file when atomic publication fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "mihomo-merge-settings-"));
  const statePath = join(root, "proxy-merge-settings.json");
  let failRename = false;
  const service = new ProxyMergeSettingsService({
    statePath,
    beforeRename: async () => {
      if (failRename) throw new Error("injected publication failure");
    },
  });
  await service.save({ expectedVersion: 0, groups: [firstGroup], exclusions: [] });
  const previous = await readFile(statePath, "utf8");
  failRename = true;
  await assert.rejects(service.save({ expectedVersion: 1, groups: [], exclusions: [] }));
  assert.equal(await readFile(statePath, "utf8"), previous);
  assert.equal((await service.read()).version, 1);
});

test("proxy merge settings API returns stable validation and version conflict errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "mihomo-merge-settings-"));
  const service = new ProxyMergeSettingsService({ statePath: join(root, "proxy-merge-settings.json") });
  const server = createConfigdServer({
    store: {} as ConfigStore,
    proxyMergeSettings: service,
    maxBodyBytes: 16 * 1024,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/proxy-merge-settings`;
  try {
    const initial = await fetch(endpoint);
    assert.equal(initial.status, 200);
    assert.equal((await initial.json() as { version: number }).version, 0);

    const created = await fetch(endpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 0, groups: [firstGroup], exclusions: [] }),
    });
    assert.equal(created.status, 200);
    assert.equal((await created.json() as { version: number }).version, 1);

    const conflict = await fetch(endpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 0, groups: [firstGroup], exclusions: [] }),
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: "proxy_merge_settings_conflict" });

    const invalid = await fetch(endpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, groups: [], exclusions: [{ provider: "", name: "" }] }),
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: "invalid_proxy_merge_settings" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
