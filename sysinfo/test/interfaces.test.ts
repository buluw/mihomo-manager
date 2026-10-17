import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, type NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readInterfaces } from "../src/interfaces.js";
import { createSysinfoServer } from "../src/server.js";

test("enumerates interfaces without IPs and keeps link state independent of addresses", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mihomo-sysinfo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, state] of Object.entries({ eth0: "up", eth1: "down", lo: "unknown", empty: "dormant", missing: null })) {
    await mkdir(join(root, name));
    if (state !== null) await writeFile(join(root, name, "operstate"), `${state}\n`);
  }
  await writeFile(join(root, "bonding_masters"), "");
  const address = (ip: string): NetworkInterfaceInfo => ({
    address: ip, family: "IPv4", cidr: `${ip}/24`, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", internal: false,
  });
  const interfaces = await readInterfaces(root, {
    eth0: [address("192.0.2.2")], eth1: [address("192.0.2.3")], lo: [address("127.0.0.1")],
  });
  assert.deepEqual(interfaces.map(({ name, state, addresses }) => [name, state, addresses.length]), [
    ["empty", "dormant", 0], ["eth0", "up", 1], ["eth1", "down", 1], ["lo", "unknown", 1], ["missing", "unknown", 0],
  ]);
  assert.deepEqual(interfaces[1]?.addresses, [{ address: "192.0.2.2", family: "IPv4", cidr: "192.0.2.2/24" }]);
  await assert.rejects(readInterfaces(join(root, "unavailable"), {}));
});

test("HTTP interface is read-only and returns a safe failure when enumeration fails", async (t) => {
  let fail = false;
  let reads = 0;
  const server = createSysinfoServer(async () => {
    reads += 1;
    if (fail) throw new Error("private host detail");
    return [{ name: "eth0", state: "unknown", addresses: [] }];
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${base}/interfaces`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { interfaces: [{ name: "eth0", state: "unknown", addresses: [] }] });
  for (const method of ["POST", "PUT", "DELETE"]) {
    const rejected = await fetch(`${base}/interfaces`, { method });
    assert.equal(rejected.status, 405);
    assert.equal(rejected.headers.get("allow"), "GET");
    await rejected.arrayBuffer();
  }
  assert.equal((await fetch(`${base}/commands`)).status, 404);
  assert.equal(reads, 1);
  fail = true;
  const unavailable = await fetch(`${base}/interfaces`);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "network_interfaces_unavailable" });
});

test("classifies loopback and renamed TUN without excluding LXC Ethernet interfaces", async t => {
  const root = await mkdtemp(join(tmpdir(), "mihomo-interface-kind-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, type, flags] of [
    ["lo", "772", null], ["eth0", "1", null], ["eth1", "1", null],
    ["renamed-core", "65534", "0x1001"], ["unknown", null, null],
  ]) {
    await mkdir(join(root, name!));
    if (type) await writeFile(join(root, name!, "type"), type);
    if (flags) await writeFile(join(root, name!, "tun_flags"), flags);
  }
  const result = await readInterfaces(root, {});
  assert.deepEqual(Object.fromEntries(result.map(item => [item.name, item.kind])), {
    eth0: "other", eth1: "other", lo: "loopback", "renamed-core": "tun", unknown: "unknown",
  });
});
