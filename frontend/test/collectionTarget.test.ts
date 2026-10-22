import assert from "node:assert/strict"
import test from "node:test"
import { cleanCollectionLocation, collectionEditLocation, collectionNavigationState, collectionSelectionLocation, collectionSourceMatches, configEditLocation, openCollectionWorkspace, readCollectionTarget, readCollectionWorkspace, resolveCommittedCollectionSource } from "../src/shared/collectionTarget.ts"

const source = { name: "未应用 A.yaml", sha256: "a".repeat(64) }

test("collection selection is retained in the parent history entry before opening its editor", () => {
  for (const view of ["list", "manage"] as const) {
    const current = { pathname: "/collections", state: { collectionTarget: { view, entry: "parent-entry", category: "proxy", collection: "previous" } } }
    const selected = collectionSelectionLocation(current, { category: "proxy", name: "chosen" })
    const editor = openCollectionWorkspace(selected, "editor", "editor-entry")
    assert.equal(readCollectionTarget(selected).name, "chosen")
    assert.equal(readCollectionTarget(editor).name, "chosen")
    assert.equal(readCollectionWorkspace(selected).entry, "parent-entry")
    assert.equal(readCollectionWorkspace(editor).returnKey, "parent-entry")
    assert.equal(readCollectionWorkspace(editor).returnView, view)
    assert.equal(readCollectionTarget(current).name, "previous")
  }
})

test("collection workspace entries preserve their parent view and selection through history copies", () => {
  const list = { pathname: "/collections", key: "list-entry", state: { collectionTarget: { category: "rule", view: "list" } } }
  const management = openCollectionWorkspace(list, "manage", "management-entry", { category: "rule", name: "selected-rule" })
  const editor = openCollectionWorkspace(management, "editor", "editor-entry", { category: "rule", name: "second-rule" })
  assert.deepEqual(readCollectionWorkspace(management), { view: "manage", entry: "management-entry", returnView: "list", returnKey: "list-entry" })
  assert.deepEqual(readCollectionWorkspace(editor), { view: "editor", entry: "editor-entry", returnView: "manage", returnKey: "management-entry" })
  assert.equal(readCollectionTarget(management).name, "selected-rule")
  assert.equal(readCollectionTarget(editor).name, "second-rule")
  assert.equal(readCollectionTarget(editor).source, null)
  assert.deepEqual(readCollectionWorkspace(cleanCollectionLocation(structuredClone(editor))), readCollectionWorkspace(editor))
})

test("collection explicit entry and source replacement retain allowed workspace metadata", () => {
  const entry = collectionEditLocation(source, { category: "proxy", name: "provider" }, "config-entry")
  assert.equal(readCollectionWorkspace(entry).returnView, "config")
  assert.equal(readCollectionWorkspace(entry).returnKey, "config-entry")
  const management = openCollectionWorkspace({ ...entry, key: "editor-entry" }, "manage", "management-entry")
  const state = collectionNavigationState(management)
  state.collectionTarget.sha256 = "b".repeat(64)
  assert.deepEqual(readCollectionWorkspace({ state }), readCollectionWorkspace(management))
  const contaminated = { state: { collectionTarget: { ...state.collectionTarget, yaml: "secret body", password: "secret", returnPath: "https://outside.invalid" } } }
  const cleaned = cleanCollectionLocation({ pathname: "/collections", ...contaminated })
  assert.deepEqual(Object.keys(cleaned.state.collectionTarget).sort(), Object.keys(state.collectionTarget).sort())
  assert.equal(readCollectionTarget(cleaned).source?.sha256, "b".repeat(64))
  assert.deepEqual(readCollectionWorkspace({ state: { collectionTarget: { view: "invalid", entry: "bad key", returnView: "outside", returnKey: "bad/key" } }, key: "valid-key" }), { view: "list", entry: "valid-key", returnView: null, returnKey: null })
})

test("collection history coordinates accepted source versions while retaining external conflict targets", () => {
  const latest = { ...source, sha256: "c".repeat(64) }
  const accepted = new Set([source.sha256, "b".repeat(64), latest.sha256])
  assert.equal(resolveCommittedCollectionSource(source, latest, accepted), latest)
  assert.equal(resolveCommittedCollectionSource({ ...source, sha256: "b".repeat(64) }, latest, accepted), latest)
  const external = { ...source, sha256: "d".repeat(64) }
  assert.equal(resolveCommittedCollectionSource(external, latest, accepted), external)
  const other = { ...source, name: "other.yaml" }
  assert.equal(resolveCommittedCollectionSource(other, latest, accepted), other)
  assert.equal(resolveCommittedCollectionSource(null, latest, accepted), null)
})

test("collection entry preserves the explicit config version and original repair item across reload and return", () => {
  const location = collectionEditLocation(source, { category: "rule", name: "原规则", repair: true })
  assert.equal(location.pathname, "/collections")
  const target = readCollectionTarget(structuredClone(location))
  assert.deepEqual(target, { source, invalid: false, category: "rule", name: "原规则", repair: true })
  const returning = configEditLocation(target.source!)
  assert.equal(returning.pathname, "/config-center")
  assert.deepEqual(readCollectionTarget(returning).source, source)
  assert.equal(collectionSourceMatches({ ...source, sha256: "b".repeat(64) }, target.source), false)
  assert.equal(collectionSourceMatches({ ...source, name: "B.yaml" }, target.source), false)
  assert.equal(collectionSourceMatches(source, target.source), true)
})

test("an incomplete explicit target stays invalid instead of selecting a runtime source", () => {
  for (const query of ["source=A.yaml", `sha256=${source.sha256}`, "source=A.yaml&sha256=bad"]) {
    const location = { pathname: "/collections", search: "?" + query }
    const target = readCollectionTarget(location)
    assert.equal(target.invalid, true)
    assert.equal(target.source, null)
    assert.deepEqual(readCollectionTarget(cleanCollectionLocation(location)), target)
  }
  assert.equal(readCollectionTarget({}).invalid, false)
  assert.equal(readCollectionTarget({}).source, null)
})

test("legacy locations migrate only target metadata and preserve explicit link precedence", () => {
  const search = "?" + new URLSearchParams({ source: source.name, sha256: source.sha256, category: "proxy", collection: "待修复集合", repair: "true", content: "draft body" })
  const legacy = { ...collectionEditLocation({ name: "other.yaml", sha256: "b".repeat(64) }), search }
  const clean = cleanCollectionLocation(legacy)
  assert.equal(clean.pathname, "/collections")
  assert.equal("search" in clean, false)
  assert.equal("content" in clean.state.collectionTarget, false)
  assert.deepEqual(readCollectionTarget(clean), { source, invalid: false, category: "proxy", name: "待修复集合", repair: true })
  assert.deepEqual(readCollectionTarget(structuredClone(clean)), readCollectionTarget(legacy))
  assert.equal(readCollectionTarget({ state: { collectionTarget: { source: source.name, sha256: 42 } } }).invalid, true)
  assert.equal(readCollectionTarget({ state: { collectionTarget: "invalid" } }).invalid, true)
})
