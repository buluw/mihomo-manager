import { sourceSettingsDocument } from "../src/shared/managerSettingsSource.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { editSetting, managerDraftOverrides, resolveSettingsValues, restoreSetting } from "../src/features/system/managerSettingsValues.ts";
import { managerSettingsForm, managerSettingsFormError } from "../src/features/system/managerSettingsForm.ts";
import type { ManagerOverrides } from "../src/api/configClient.ts";

const runtime = { mode: "rule", ipv6: true, "interface-name": "", tun: { enable: false, stack: "gvisor", "auto-detect-interface": true, "dns-hijack": ["0.0.0.0:53"] }, dns: { listen: "" }, sniffer: { sniff: {} } };

test("explicit manager and source values resolve separately from runtime references and writes", () => {
  const saved: ManagerOverrides = { ipv6: false, mode: "global", tun: { "auto-route": false } };
  const draft = managerSettingsForm(saved);
  const source = sourceSettingsDocument("ipv6: true\nmode: direct\ndns:\n  enable: true\n  nameserver: [1.1.1.1]\n");
  const result = resolveSettingsValues(draft, source, runtime);
  assert.equal(result.form.ipv6, "disabled"); assert.equal(result.form.mode, "global");
  assert.equal(result.form.dnsEnable, "enabled"); assert.equal(result.form.dnsNameservers, "1.1.1.1");
  assert.equal(result.form.tunStack, "follow"); assert.equal(result.form.tunAutoRoute, "disabled");
  assert.equal(result.status.tunStack, "跟随 Core · 当前：gvisor");
  assert.equal(result.status.tunDnsHijack, "跟随 Core · 当前：0.0.0.0:53");
  assert.deepEqual(result.form.sniffProtocols, []); assert.equal(result.form.httpPorts, "");
  assert.equal(result.form.dnsListen, ""); assert.equal(result.known.has("dnsListen"), false);
  assert.equal(result.status.dnsListen, "跟随 Core · 当前：空");
  assert.deepEqual(managerDraftOverrides(saved, draft, new Set()), saved);
});

test("one edit changes only that setting and preserves saved optional-field shape", () => {
  const saved: ManagerOverrides = { mode: "rule", "interface-name": "eth0", sniffer: { sniff: { TLS: {} } } };
  const draft = managerSettingsForm(saved);
  const display = resolveSettingsValues(draft, { "allow-lan": true }, runtime);
  const edited = editSetting(draft, display.form, "allowLan", { allowLan: "disabled" });
  const next = managerDraftOverrides(saved, edited, new Set(["allowLan"]));
  assert.deepEqual(next, { ...saved, "allow-lan": false });
  assert.equal(next.tun, undefined); assert.deepEqual(next.sniffer?.sniff, { TLS: {} });
});

test("valid runtime false, empty lists and empty strings remain reference text only", () => {
  const draft = managerSettingsForm({});
  const current = { ipv6: false, dns: { listen: "", nameserver: [] }, tun: { "dns-hijack": [] }, sniffer: { sniff: { TLS: { ports: [0, 443] } } } };
  const value = resolveSettingsValues(draft, {}, current);
  assert.equal(value.known.size, 0);
  assert.equal(value.status.ipv6, "跟随 Core · 当前：停用");
  assert.equal(value.status.dnsListen, "跟随 Core · 当前：空");
  assert.equal(value.status.dnsNameservers, "跟随 Core · 当前：空列表");
  assert.equal(value.status.tunDnsHijack, "跟随 Core · 当前：空列表");
  assert.equal(value.status.sniffProtocols, "跟随 Core · 当前：TLS（0、443）");
  assert.deepEqual(managerDraftOverrides({}, draft, new Set()), {});
  const edit = editSetting(draft, value.form, "logLevel", { logLevel: "error" });
  assert.deepEqual(managerDraftOverrides({}, edit, new Set(["logLevel"])), { "log-level": "error" });
  const refresh = resolveSettingsValues(edit, {}, { ipv6: true, tun: { "dns-hijack": ["any:53"] } });
  assert.equal(refresh.form.logLevel, "error");
  assert.equal(refresh.form.tunDnsHijack, "");
  assert.equal(refresh.status.tunDnsHijack, "跟随 Core · 当前：any:53");
  assert.deepEqual(managerDraftOverrides({}, edit, new Set(["logLevel"])), { "log-level": "error" });
});

test("Controller native stack casing and sniffing flag are projected only as current references", () => {
  const value = resolveSettingsValues(managerSettingsForm({}), {}, { tun: { stack: "gVisor" }, sniffing: false });
  assert.equal(value.status.tunStack, "跟随 Core · 当前：gvisor");
  assert.equal(value.status.snifferEnable, "跟随 Core · 当前：停用");
  assert.equal(value.form.tunStack, "follow");
  assert.equal(value.form.snifferEnable, "follow");
  assert.equal(value.known.size, 0);
});

test("explicit false, empty values and zero ports take precedence over current values", () => {
  const source = { ipv6: false, dns: { listen: "", nameserver: [] }, tun: { "dns-hijack": [] }, sniffer: { sniff: { HTTP: { ports: [0] } } } };
  const value = resolveSettingsValues(managerSettingsForm({}), source, runtime);
  assert.equal(value.form.ipv6, "disabled");
  assert.equal(value.form.dnsListen, "");
  assert.equal(value.form.dnsNameservers, "");
  assert.equal(value.form.httpPorts, "0");
  for (const group of ["ipv6", "dnsListen", "dnsNameservers", "tunDnsHijack", "sniffProtocols"] as const) {
    assert.ok(value.known.has(group)); assert.equal(value.status[group], undefined);
  }
  const overrides: ManagerOverrides = { ipv6: false, dns: { nameserver: [] }, tun: { "dns-hijack": [] } };
  const explicit = resolveSettingsValues(managerSettingsForm(overrides), { ipv6: true, dns: { nameserver: ["1.1.1.1"] } }, runtime);
  assert.equal(explicit.form.ipv6, "disabled");
  assert.equal(explicit.form.dnsNameservers, "");
  assert.equal(explicit.status.tunDnsHijack, undefined);
});

test("unavailable and invalid runtime fields preserve Core following without invented values", () => {
  for (const current of [null, {}, [], false, { ipv6: 0, mode: ["rule"], tun: { "dns-hijack": [53] }, dns: null, sniffer: { sniff: false } }]) {
    const value = resolveSettingsValues(managerSettingsForm({}), {}, current);
    assert.equal(value.status.ipv6, "跟随 Core");
    assert.equal(value.status.mode, "跟随 Core");
    assert.equal(value.status.tunDnsHijack, "跟随 Core");
    assert.equal(value.status.sniffProtocols, "跟随 Core");
    assert.equal(value.invalid.size, 0);
  }
  for (const source of [{ tun: { "dns-hijack": null } }, { tun: [] }, { tun: false }]) {
    const value = resolveSettingsValues(managerSettingsForm({}), source, runtime);
    assert.match(value.status.tunDnsHijack!, /源配置值格式无效/);
    assert.doesNotMatch(value.status.tunDnsHijack!, /跟随|当前/);
  }
  const repaired = resolveSettingsValues(managerSettingsForm({ tun: { "dns-hijack": [] } }), { tun: null }, runtime);
  assert.equal(repaired.status.tunDnsHijack, undefined);
});

test("restore removes only the chosen draft setting; source switching and cancellation preserve the right values", () => {
  const saved: ManagerOverrides = { ipv6: false, mode: "global", dns: { enable: true } };
  let draft = managerSettingsForm(saved);
  draft = restoreSetting(draft, "ipv6");
  assert.deepEqual(saved, { ipv6: false, mode: "global", dns: { enable: true } });
  assert.equal(resolveSettingsValues(draft, { ipv6: true, mode: "direct" }, runtime).form.ipv6, "enabled");
  const sourceB = resolveSettingsValues(draft, { ipv6: false, mode: "rule", dns: { listen: "127.0.0.1:1053" } }, runtime);
  assert.equal(sourceB.form.ipv6, "disabled"); assert.equal(sourceB.form.mode, "global");
  assert.equal(sourceB.form.dnsListen, "127.0.0.1:1053");
  assert.equal(resolveSettingsValues(draft, {}, runtime).form.ipv6, "follow");
  assert.deepEqual(managerDraftOverrides(saved, draft, new Set(["ipv6"])), { mode: "global", dns: { enable: true } });
  assert.deepEqual(managerDraftOverrides(saved, managerSettingsForm(saved), new Set()), saved);
});

test("missing runtime remains following and malformed source stays diagnosed", () => {
  const draft = managerSettingsForm({ ipv6: true });
  const unknown = resolveSettingsValues(draft, { "allow-lan": true }, null);
  assert.equal(unknown.form.ipv6, "enabled"); assert.equal(unknown.form.allowLan, "enabled");
  assert.equal(unknown.form.tunEnable, "follow"); assert.equal(unknown.known.has("tunEnable"), false);
  assert.equal(unknown.known.has("dnsListen"), false); assert.deepEqual(unknown.form.sniffProtocols, []);
  const invalid = resolveSettingsValues(managerSettingsForm({}), { ipv6: "not-a-boolean", dns: null }, runtime);
  assert.equal(invalid.known.has("ipv6"), false); assert.equal(invalid.known.has("dnsEnable"), false);
  assert.match(invalid.status.ipv6!, /源配置值格式无效/);
  assert.match(invalid.status.dnsEnable!, /源配置值格式无效/);
  assert.equal(unknown.status.tunEnable, "跟随 Core");
  assert.throws(() => sourceSettingsDocument("dns: [\n"), /无法解析/);
});

test("outbound fields inherit separately before deriving the displayed mode", () => {
  const cases: Array<{ saved: ManagerOverrides; source: Record<string, unknown>; mode: string; name: string }> = [
    { saved: { tun: { "auto-detect-interface": false } }, source: { "interface-name": "eth0" }, mode: "manual", name: "eth0" },
    { saved: { "interface-name": "" }, source: { "interface-name": "eth0", tun: { "auto-detect-interface": false } }, mode: "system", name: "" },
  ]
  for (const { saved, source, mode, name } of cases) {
    const draft = managerSettingsForm(saved)
    const display = resolveSettingsValues(draft, source, runtime)
    assert.equal(display.form.outboundMode, mode)
    assert.equal(display.form.interfaceName, name)
    assert.ok(display.explicit.has("outboundMode"))
    assert.deepEqual(managerDraftOverrides(saved, draft, new Set()), saved)
    const otherEdit = editSetting(draft, display.form, "logLevel", { logLevel: "warning" })
    assert.deepEqual(managerDraftOverrides(saved, otherEdit, new Set(["logLevel"])), { ...saved, "log-level": "warning" })
    const restored = restoreSetting(draft, "outboundMode")
    assert.deepEqual(managerDraftOverrides(saved, restored, new Set(["outboundMode"])), {})
    const auto = editSetting(draft, display.form, "outboundMode", { outboundMode: "auto" })
    assert.equal(resolveSettingsValues(auto, source, runtime).form.outboundMode, "auto")
    assert.deepEqual(managerDraftOverrides(saved, auto, new Set(["outboundMode"])), { "interface-name": "", tun: { "auto-detect-interface": true } })
  }
  assert.equal(resolveSettingsValues(managerSettingsForm({ tun: { "auto-detect-interface": false } }), { "interface-name": "eth1" }, runtime).form.interfaceName, "eth1")
  assert.equal(resolveSettingsValues(managerSettingsForm({ "interface-name": "" }), {}, null).known.has("outboundMode"), false)
})

test("manual outbound draft keeps its mode while the required interface name is empty", () => {
  const base = managerSettingsForm({})
  const automatic = resolveSettingsValues(base, {}, runtime).form
  let draft = editSetting(base, automatic, "outboundMode", { outboundMode: "manual" })
  let visible = resolveSettingsValues(draft, {}, runtime).form
  assert.equal(visible.outboundMode, "manual")
  assert.equal(visible.interfaceName, "")
  assert.match(managerSettingsFormError(draft)!, /必须填写网卡名称/)
  assert.equal(resolveSettingsValues(draft, { "interface-name": "eth9" }, runtime).form.outboundMode, "manual")
  draft = editSetting(draft, visible, "outboundMode", { interfaceName: "eth0" })
  visible = resolveSettingsValues(draft, {}, runtime).form
  assert.equal(visible.outboundMode, "manual")
  assert.equal(visible.interfaceName, "eth0")
  assert.equal(managerSettingsFormError(draft), null)
  assert.deepEqual(managerDraftOverrides({}, draft, new Set(["outboundMode"])), { "interface-name": "eth0", tun: { "auto-detect-interface": false } })
  draft = editSetting(draft, visible, "outboundMode", { interfaceName: "" })
  assert.equal(resolveSettingsValues(draft, {}, runtime).form.outboundMode, "manual")
  assert.match(managerSettingsFormError(draft)!, /必须填写网卡名称/)
  assert.equal(resolveSettingsValues(restoreSetting(draft, "outboundMode"), {}, runtime).form.outboundMode, "follow")
})

test("source aliases, empty lists, automatic exit and sniffer ports use Core semantics", () => {
  const source = sourceSettingsDocument("base: &dns\n  ipv6: true\ndns:\n  <<: *dns\n  fake-ip-filter: []\ntun:\n  auto-detect-interface: false\nsniffer:\n  sniff:\n    TLS: {}\n");
  const draft = managerSettingsForm({});
  const value = resolveSettingsValues(draft, source, runtime);
  assert.equal(value.form.dnsIpv6, "enabled"); assert.equal(value.form.dnsFakeIpFilter, "");
  assert.equal(value.form.outboundMode, "follow"); assert.equal(value.form.autoDetectInterface, "disabled"); assert.equal(value.form.tlsPorts, "");
  assert.deepEqual(value.form.sniffProtocols, ["TLS"]);
  const edit = editSetting(draft, value.form, "sniffProtocols", { tlsPorts: "" });
  assert.equal(managerSettingsFormError(edit), null);
  assert.deepEqual(managerDraftOverrides({}, edit, new Set(["sniffProtocols"])), { sniffer: { sniff: { TLS: { ports: [] } } } });
  const legacy = resolveSettingsValues(draft, { sniffer: { sniffing: ["tls"], ports: [443] } }, runtime);
  assert.deepEqual(legacy.form.sniffProtocols, ["TLS"]); assert.equal(legacy.form.tlsPorts, "443");
});
