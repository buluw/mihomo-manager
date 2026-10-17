import { proxyCollectionCount, ruleCollectionCount } from "../src/shared/collectionContent.ts"
import assert from "node:assert/strict"
import test from "node:test"
import { collectionUploadMatches, collectionUploadTargets, createCollectionDraft, latestMissingCollectionDeclaration, patchUploadDeclaration, readUploadDeclaration, proxyCollectionGroups } from "../src/features/providers/proxyCollectionImport.ts"
import { managedCollectionItems, managedProviderItems } from "../src/features/providers/managedProviderModel.ts"
import { updateManagedProviderConfig } from "../src/features/providers/managedProviderYaml.ts"
import { parse } from "yaml"

test("adopting a latest missing collection declaration retains the input and binds its latest path", () => {
  for (const category of ["proxy", "rule"] as const) {
    const directory = category === "proxy" ? "providers" : "ruleset"
    const draft = { category, operationId: "retained-operation", name: "sample", groupNames: ["Route"],
      content: category === "proxy" ? "proxies: [{name: draft, type: direct}]" : "payload: [example.invalid]",
      snippet: "sample: {type: file, path: ./" + directory + "/old.yaml, behavior: domain}" }
    const source = { name: "A.yaml", sha256: "latest", path: "/configs/A.yaml",
      content: category + "-providers:\n  sample: {type: file, path: ./" + directory + "/new.yaml, behavior: domain, interval: 600}\n",
      providerIssues: [{ category, name: "sample", status: "missing" as const }] }
    const rebased = { ...draft, snippet: latestMissingCollectionDeclaration(draft, source) }
    assert.equal(parse(rebased.snippet).sample.path, "./" + directory + "/new.yaml")
    assert.equal(parse(rebased.snippet).sample.interval, 600)
    assert.equal(rebased.content, draft.content)
    assert.equal(rebased.operationId, draft.operationId)
    assert.deepEqual(rebased.groupNames, draft.groupNames)
    assert.throws(() => latestMissingCollectionDeclaration(draft, { ...source, providerIssues: [] }), /目标已变化/)
    assert.throws(() => latestMissingCollectionDeclaration(draft, { ...source, content: source.content.replace("type: file", "type: http") }), /目标已变化/)
  }
})

test("upload declaration form edits preserve custom settings and keep file bodies separate", () => {
  const original = 'sample:\n  type: file\n  path: ./ruleset/sample.yaml\n  behavior: classical\n  format: yaml\n  size-limit: 5000\n'
  const changed = patchUploadDeclaration(original, "rule", { name: "renamed", behavior: "domain" })
  assert.deepEqual(readUploadDeclaration(changed, "rule"), { name: "renamed", declaration: { type: "file", path: "./ruleset/sample.yaml", behavior: "domain", format: "yaml", "size-limit": 5000 } })
  assert.equal(readUploadDeclaration(original, "rule").name, "sample")
  const empty = patchUploadDeclaration(original, "rule", { name: "" })
  assert.equal(readUploadDeclaration(patchUploadDeclaration(empty, "rule", { name: "fixed" }), "rule").name, "fixed")
  assert.throws(() => readUploadDeclaration(original.replace("type: file", "type: http"), "rule"))
  assert.throws(() => readUploadDeclaration(original + '  payload: [example.invalid]\n', "rule"))
})

test("Inline and HTTP creation share group validation and preserve unrelated configuration", () => {
  const source = "proxy-groups: [{name: existing, type: select, proxies: [DIRECT]}]\nrules: [MATCH,DIRECT]\n"
  const input = { operationId: "sample-operation", name: "sample", content: "proxies: [{name: demo, type: direct}]", groupNames: ["existing"] }
  const inline = parse(createCollectionDraft(source, input, "inline", "").content)
  assert.deepEqual(inline["proxy-providers"].sample, { type: "inline", payload: [{ name: "demo", type: "direct" }] })
  assert.deepEqual(inline["proxy-groups"][0].use, ["sample"])
  assert.deepEqual(inline.rules, parse(source).rules)
  const http = parse(createCollectionDraft(source, { ...input, groupNames: [], newGroupName: "new-group" }, "http", "https://example.invalid/sample.yaml").content)
  assert.equal(http["proxy-providers"].sample.type, "http")
  assert.equal(http["proxy-providers"].sample.payload, undefined)
  assert.deepEqual(http["proxy-groups"][1].use, ["sample"])
  assert.throws(() => createCollectionDraft(source, { ...input, groupNames: [] }, "inline", ""), /代理组/)
  assert.throws(() => createCollectionDraft(source, input, "http", "file:///sample.yaml"))
  assert.throws(() => createCollectionDraft(source, { ...input, name: "existing" }, "inline", ""), /冲突/)
})

test("collection editor counts nodes and rejects a full configuration or invalid entries", () => {
  assert.equal(proxyCollectionCount("proxies:\n  - {name: test, type: direct}\n"), 1)
  assert.throws(() => proxyCollectionCount("proxies: []\n"))
  assert.throws(() => proxyCollectionCount("proxies: [{name: test}]\n"))
  assert.throws(() => proxyCollectionCount("proxies: [{name: test, type: direct}]\nproxy-groups: []\nrules: []\n"), /完整主配置/)
})

test("missing File items stay listed and upload matching preserves ambiguity without fuzzy binding", () => {
  const snapshot = { name: "migration.yaml", path: "/configs/migration.yaml", sha256: "test",
    content: "proxy-providers:\n  west: {type: file, path: ./nodes.yaml}\n  east: {type: file, path: ./other/nodes.yaml}\n  remote: {type: http, path: ./cache.yaml, url: https://example.invalid}\nproxy-groups:\n  - {name: All, type: select, include-all-providers: true}\n",
    providerIssues: [{ category: "proxy" as const, name: "west", status: "missing" as const }, { category: "proxy" as const, name: "east", status: "missing" as const }] }
  const items = managedProviderItems(snapshot, [], "proxy")
  assert.deepEqual(collectionUploadMatches("nodes.yaml", items).map((item) => item.name).sort(), ["east", "west"])
  assert.deepEqual(collectionUploadMatches("west.yml", items).map((item) => item.name), ["west"])
  assert.deepEqual(collectionUploadMatches("nodes-new.yaml", items), [])
  assert.deepEqual(collectionUploadMatches("cache.yaml", items), [])
  assert.deepEqual(items.find((item) => item.name === "west")?.selectedGroups, ["All"])
  assert.deepEqual(proxyCollectionGroups(snapshot.content), [{ name: "All", implicit: true }])
})

test("pending removal keeps the selected alias and original declaration until save, and undo restores references", () => {
  const baseline = { name: "draft.yaml", path: "/configs/draft.yaml", sha256: "baseline", content: `
proxy-providers:
  alias: {type: file, path: ./providers/nodes.yaml, health-check: {enable: true, url: https://example.invalid, interval: 300}}
proxy-groups:
  - {name: Manual, type: select, proxies: [DIRECT], use: [alias]}
  - {name: Auto, type: select, include-all-providers: true}
` }
  const file = { fileName: "nodes.yaml", referencePath: "./providers/nodes.yaml", category: "proxy" as const,
    source: "manual" as const, writable: true, sha256: "nodes", size: 10, updatedAt: "", filterSettings: null, extractionId: null }
  for (const files of [[], [file]]) {
    const item = managedCollectionItems(baseline, files, "proxy")[0]!
    const removed = { ...baseline, content: updateManagedProviderConfig(baseline.content, item, { loaded: false }) }
    const pending = managedCollectionItems(removed, files, "proxy", [], baseline)
    assert.equal(pending.length, 1)
    assert.equal(pending[0]!.id, item.id)
    assert.equal(pending[0]!.pendingRemoval, true)
    assert.equal(pending[0]!.declared, false)
    const restored = updateManagedProviderConfig(removed.content, pending[0]!, { loaded: true, selectedGroups: item.selectedGroups })
    assert.deepEqual(parse(restored), parse(baseline.content))
    assert.equal(managedCollectionItems(removed, files, "proxy").some((row) => row.pendingRemoval), false)
    assert.equal(managedCollectionItems(baseline, files, "proxy", [], baseline)[0]!.pendingRemoval, undefined)
  }
})

test("multiple pending removals remain independent while another collection is still declared", () => {
  const baseline = { name: "multiple.yaml", path: "/configs/multiple.yaml", sha256: "baseline", content: `
proxy-providers:
  first: {type: file, path: ./missing.yaml}
  second: {type: http, path: ./cache.yaml, url: https://example.invalid, interval: 60}
  kept: {type: file, path: ./kept.yaml}
proxy-groups:
  - {name: All, type: select, include-all-providers: true}
` }
  const original = managedCollectionItems(baseline, [], "proxy")
  let content = baseline.content
  for (const item of original.filter((row) => row.name !== "kept")) content = updateManagedProviderConfig(content, item, { loaded: false })
  const rows = managedCollectionItems({ ...baseline, content }, [], "proxy", [], baseline)
  assert.deepEqual(rows.filter((row) => row.pendingRemoval).map((row) => row.name).sort(), ["first", "second"])
  assert.equal(rows.find((row) => row.name === "kept")?.declared, true)
  const second = rows.find((row) => row.name === "second")!
  const restored = updateManagedProviderConfig(content, second, { loaded: true, selectedGroups: second.selectedGroups })
  assert.equal(parse(restored)["proxy-providers"].second.interval, 60)
  assert.equal(managedCollectionItems({ ...baseline, content: restored }, [], "proxy", [], baseline).filter((row) => row.pendingRemoval).length, 1)
})

test("shared-file aliases keep separate pending removals and each can be undone without a duplicate file row", () => {
  const file = { fileName: "fixture.yaml", referencePath: "./providers/fixture.yaml", category: "proxy" as const,
    source: "manual" as const, writable: true, sha256: "file", size: 10, updatedAt: "", filterSettings: null, extractionId: null }
  for (const keepCanonical of [false, true]) {
    const baseline = { name: "aliases.yaml", path: "/configs/aliases.yaml", sha256: "baseline", content: `
proxy-providers:
${keepCanonical ? "  fixture: {type: file, path: ./providers/fixture.yaml}\n" : ""}  AliasOne: {type: file, path: ./providers/fixture.yaml, filter: one}
  AliasTwo: {type: file, path: ./providers/fixture.yaml, filter: two}
proxy-groups:
  - {name: Manual, type: select, proxies: [DIRECT], use: [AliasOne, AliasTwo]}
` }
    let content = baseline.content
    const rows = () => managedCollectionItems({ ...baseline, content }, [file], "proxy", [], baseline)
    for (const name of ["AliasTwo", "AliasOne"]) {
      const selected = rows().find((item) => item.name === name)!
      content = updateManagedProviderConfig(content, selected, { loaded: false })
      assert.equal(rows().find((item) => item.id === selected.id)?.pendingRemoval, true)
    }
    assert.deepEqual(rows().filter((item) => item.pendingRemoval).map((item) => item.name).sort(), ["AliasOne", "AliasTwo"])
    assert.equal(rows().length, keepCanonical ? 3 : 2)
    for (const name of ["AliasTwo", "AliasOne"]) {
      const selected = rows().find((item) => item.name === name)!
      content = updateManagedProviderConfig(content, selected, { loaded: true, selectedGroups: selected.selectedGroups })
      assert.equal(rows().find((item) => item.id === selected.id)?.declared, true)
      if (name === "AliasTwo") assert.equal(rows().find((item) => item.name === "AliasOne")?.pendingRemoval, true)
    }
    assert.deepEqual(parse(content)["proxy-providers"], parse(baseline.content)["proxy-providers"])
    assert.deepEqual([...parse(content)["proxy-groups"][0].use].sort(), ["AliasOne", "AliasTwo"])
    assert.equal(rows().some((item) => item.pendingRemoval), false)
  }
})

test("rule creation uses RULE-SET before the fallback, preserves groups, and supports all source types", () => {
  const source = 'proxy-groups: [{name: Route, type: select, proxies: [DIRECT]}]\nrules: ["DOMAIN,existing.invalid,DIRECT", "MATCH,Route"]\n'
  const input = { operationId: "sample-operation", name: "sample", content: "payload: [DOMAIN-SUFFIX,example.invalid]", groupNames: [], behavior: "domain", ruleSetRules: ["RULE-SET,sample,Route"] }
  for (const type of ["inline", "file", "http"] as const) {
    const value = parse(createCollectionDraft(source, { ...input, interval: 7200 }, type, "https://example.invalid/rules.yaml", "rule", "./ruleset/existing.yaml").content)
    assert.equal(value["rule-providers"].sample.type, type)
    assert.equal(value["rule-providers"].sample.format, "yaml")
    assert.equal(value["rule-providers"].sample.behavior, "domain")
    assert.deepEqual(value["proxy-groups"], parse(source)["proxy-groups"])
    assert.deepEqual(value.rules, ["DOMAIN,existing.invalid,DIRECT", "RULE-SET,sample,Route", "MATCH,Route"])
    if (type === "http") assert.equal(value["rule-providers"].sample.interval, 7200)
  }
  assert.equal(parse(createCollectionDraft(source, { ...input, interval: 0 }, "http", "https://example.invalid/rules.yaml", "rule").content)["rule-providers"].sample.interval, 0)
  assert.throws(() => createCollectionDraft(source, { ...input, ruleSetRules: [] }, "inline", "", "rule"))
  assert.throws(() => createCollectionDraft(source, { ...input, ruleSetRules: ["RULE-SET,sample,missing"] }, "inline", "", "rule"))
  assert.equal(ruleCollectionCount('payload: ["DOMAIN,example.invalid"]'), 1)
  assert.throws(() => ruleCollectionCount('payload: [42]'))
})

test("upload targets include missing and writable ordinary File and exclude downloaded or extracted bodies", () => {
  const file = { fileName: "existing.yaml", referencePath: "./providers/existing.yaml", category: "proxy" as const, source: "external" as const, writable: true, sha256: "existing", size: 5, updatedAt: "", filterSettings: null, extractionId: null }
  const snapshot = { name: "source.yaml", path: "/configs/source.yaml", sha256: "source", content: 'proxy-providers:\n  existing: {type: file, path: ./providers/existing.yaml}\n  missing: {type: file, path: ./providers/missing.yaml}\n  http: {type: http, path: ./providers/cache.yaml, url: https://example.invalid}\n  inline: {type: inline, payload: []}\n', providerIssues: [{ category: "proxy" as const, name: "missing", status: "missing" as const }] }
  const rows = managedProviderItems(snapshot, [file], "proxy")
  assert.deepEqual(collectionUploadTargets(rows, "proxy").map((item) => item.name).sort(), ["existing", "missing"])
  assert.deepEqual(collectionUploadMatches("existing.yaml", rows).map((item) => item.name), ["existing"])
  for (const access of ["local", "subscription", "http"] as const) {
    assert.deepEqual(collectionUploadTargets(rows.map((item) => ({ ...item, access })), "proxy"), [])
  }
})
