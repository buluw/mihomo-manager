import { coreSettingsDefaults, sourceSettingsDocument } from "../src/shared/managerSettingsSource.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { editSetting, managerDraftOverrides, resolveSettingsValues, restoreSetting } from "../src/features/system/managerSettingsValues.ts";
import { managerSettingsForm, managerSettingsFormError } from "../src/features/system/managerSettingsForm.ts";
import type { ManagerOverrides } from "../src/api/configClient.ts";

const identity = { version: "v1.19.29", sha256: "bd2a08ae155b7dffc12a1bdf610ff5f17c45058414a1d2c562e28eb9309abff6" };
const defaults = coreSettingsDefaults(identity)!;

test("saved settings, chosen source and verified version defaults resolve separately from writes", () => {
  const saved: ManagerOverrides = { ipv6: false, mode: "global", tun: { "auto-route": false } };
  const draft = managerSettingsForm(saved);
  const source = sourceSettingsDocument("ipv6: true\nmode: direct\ndns:\n  enable: true\n  nameserver: [1.1.1.1]\n");
  const result = resolveSettingsValues(draft, source, defaults);
  assert.equal(result.form.ipv6, "disabled"); assert.equal(result.form.mode, "global");
  assert.equal(result.form.dnsEnable, "enabled"); assert.equal(result.form.dnsNameservers, "1.1.1.1");
  assert.equal(result.form.tunStack, "gvisor"); assert.equal(result.form.tunAutoRoute, "disabled");
  assert.deepEqual(result.form.sniffProtocols, []); assert.equal(result.form.httpPorts, "");
  assert.equal(result.form.dnsListen, ""); assert.ok(result.known.has("dnsListen"));
  assert.deepEqual(managerDraftOverrides(saved, draft, new Set()), saved);
});

test("one edit changes only that setting and preserves saved optional-field shape", () => {
  const saved: ManagerOverrides = { mode: "rule", "interface-name": "eth0", sniffer: { sniff: { TLS: {} } } };
  const draft = managerSettingsForm(saved);
  const display = resolveSettingsValues(draft, { "allow-lan": true }, defaults);
  const edited = editSetting(draft, display.form, "allowLan", { allowLan: "disabled" });
  const next = managerDraftOverrides(saved, edited, new Set(["allowLan"]));
  assert.deepEqual(next, { ...saved, "allow-lan": false });
  assert.equal(next.tun, undefined); assert.deepEqual(next.sniffer?.sniff, { TLS: {} });
});

test("restore removes only the chosen draft setting; source switching and cancellation preserve the right values", () => {
  const saved: ManagerOverrides = { ipv6: false, mode: "global", dns: { enable: true } };
  let draft = managerSettingsForm(saved);
  draft = restoreSetting(draft, "ipv6");
  assert.deepEqual(saved, { ipv6: false, mode: "global", dns: { enable: true } });
  assert.equal(resolveSettingsValues(draft, { ipv6: true, mode: "direct" }, defaults).form.ipv6, "enabled");
  const sourceB = resolveSettingsValues(draft, { ipv6: false, mode: "rule", dns: { listen: "127.0.0.1:1053" } }, defaults);
  assert.equal(sourceB.form.ipv6, "disabled"); assert.equal(sourceB.form.mode, "global");
  assert.equal(sourceB.form.dnsListen, "127.0.0.1:1053");
  assert.equal(resolveSettingsValues(draft, {}, defaults).form.ipv6, "enabled");
  assert.deepEqual(managerDraftOverrides(saved, draft, new Set(["ipv6"])), { mode: "global", dns: { enable: true } });
  assert.deepEqual(managerDraftOverrides(saved, managerSettingsForm(saved), new Set()), saved);
});

test("unknown binaries and unsupported source values stay unknown, while explicit values remain usable", () => {
  for (const core of [null, { ...identity, version: "v9.0.0" }, { ...identity, sha256: "custom" }]) assert.equal(coreSettingsDefaults(core), null);
  assert.ok(coreSettingsDefaults({ version: "v1.19.31", sha256: "b341a765412c192685264e038a6aad2ac1c67c12b8aceeb5c6f64955cf43f5ed" }));
  const draft = managerSettingsForm({ ipv6: true });
  const unknown = resolveSettingsValues(draft, { "allow-lan": true }, null);
  assert.equal(unknown.form.ipv6, "enabled"); assert.equal(unknown.form.allowLan, "enabled");
  assert.equal(unknown.form.tunEnable, "follow"); assert.equal(unknown.known.has("tunEnable"), false);
  assert.equal(unknown.known.has("dnsListen"), false); assert.deepEqual(unknown.form.sniffProtocols, []);
  const invalid = resolveSettingsValues(managerSettingsForm({}), { ipv6: "not-a-boolean", dns: null }, defaults);
  assert.equal(invalid.known.has("ipv6"), false); assert.equal(invalid.known.has("dnsEnable"), false);
  assert.throws(() => sourceSettingsDocument("dns: [\n"), /无法解析/);
});

test("outbound fields inherit separately before deriving the displayed mode", () => {
  const cases: Array<{ saved: ManagerOverrides; source: Record<string, unknown>; mode: string; name: string }> = [
    { saved: { tun: { "auto-detect-interface": false } }, source: { "interface-name": "eth0" }, mode: "manual", name: "eth0" },
    { saved: { "interface-name": "" }, source: { "interface-name": "eth0", tun: { "auto-detect-interface": false } }, mode: "system", name: "" },
  ]
  for (const { saved, source, mode, name } of cases) {
    const draft = managerSettingsForm(saved)
    const display = resolveSettingsValues(draft, source, defaults)
    assert.equal(display.form.outboundMode, mode)
    assert.equal(display.form.interfaceName, name)
    assert.ok(display.explicit.has("outboundMode"))
    assert.deepEqual(managerDraftOverrides(saved, draft, new Set()), saved)
    const otherEdit = editSetting(draft, display.form, "logLevel", { logLevel: "warning" })
    assert.deepEqual(managerDraftOverrides(saved, otherEdit, new Set(["logLevel"])), { ...saved, "log-level": "warning" })
    const restored = restoreSetting(draft, "outboundMode")
    assert.deepEqual(managerDraftOverrides(saved, restored, new Set(["outboundMode"])), {})
    const auto = editSetting(draft, display.form, "outboundMode", { outboundMode: "auto" })
    assert.equal(resolveSettingsValues(auto, source, defaults).form.outboundMode, "auto")
    assert.deepEqual(managerDraftOverrides(saved, auto, new Set(["outboundMode"])), { "interface-name": "", tun: { "auto-detect-interface": true } })
  }
  assert.equal(resolveSettingsValues(managerSettingsForm({ tun: { "auto-detect-interface": false } }), { "interface-name": "eth1" }, defaults).form.interfaceName, "eth1")
  assert.equal(resolveSettingsValues(managerSettingsForm({ "interface-name": "" }), {}, null).known.has("outboundMode"), false)
})

test("manual outbound draft keeps its mode while the required interface name is empty", () => {
  const base = managerSettingsForm({})
  const automatic = resolveSettingsValues(base, {}, defaults).form
  let draft = editSetting(base, automatic, "outboundMode", { outboundMode: "manual" })
  let visible = resolveSettingsValues(draft, {}, defaults).form
  assert.equal(visible.outboundMode, "manual")
  assert.equal(visible.interfaceName, "")
  assert.match(managerSettingsFormError(draft)!, /必须填写网卡名称/)
  assert.equal(resolveSettingsValues(draft, { "interface-name": "eth9" }, defaults).form.outboundMode, "manual")
  draft = editSetting(draft, visible, "outboundMode", { interfaceName: "eth0" })
  visible = resolveSettingsValues(draft, {}, defaults).form
  assert.equal(visible.outboundMode, "manual")
  assert.equal(visible.interfaceName, "eth0")
  assert.equal(managerSettingsFormError(draft), null)
  assert.deepEqual(managerDraftOverrides({}, draft, new Set(["outboundMode"])), { "interface-name": "eth0", tun: { "auto-detect-interface": false } })
  draft = editSetting(draft, visible, "outboundMode", { interfaceName: "" })
  assert.equal(resolveSettingsValues(draft, {}, defaults).form.outboundMode, "manual")
  assert.match(managerSettingsFormError(draft)!, /必须填写网卡名称/)
  assert.equal(resolveSettingsValues(restoreSetting(draft, "outboundMode"), {}, defaults).form.outboundMode, "auto")
})

test("source aliases, empty lists, automatic exit and sniffer ports use Core semantics", () => {
  const source = sourceSettingsDocument("base: &dns\n  ipv6: true\ndns:\n  <<: *dns\n  fake-ip-filter: []\ntun:\n  auto-detect-interface: false\nsniffer:\n  sniff:\n    TLS: {}\n");
  const draft = managerSettingsForm({});
  const value = resolveSettingsValues(draft, source, defaults);
  assert.equal(value.form.dnsIpv6, "enabled"); assert.equal(value.form.dnsFakeIpFilter, "");
  assert.equal(value.form.outboundMode, "system"); assert.equal(value.form.tlsPorts, "");
  assert.deepEqual(value.form.sniffProtocols, ["TLS"]);
  const edit = editSetting(draft, value.form, "sniffProtocols", { tlsPorts: "" });
  assert.equal(managerSettingsFormError(edit), null);
  assert.deepEqual(managerDraftOverrides({}, edit, new Set(["sniffProtocols"])), { sniffer: { sniff: { TLS: { ports: [] } } } });
  const legacy = resolveSettingsValues(draft, { sniffer: { sniffing: ["tls"], ports: [443] } }, defaults);
  assert.deepEqual(legacy.form.sniffProtocols, ["TLS"]); assert.equal(legacy.form.tlsPorts, "443");
});
