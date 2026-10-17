import assert from "node:assert/strict"
import test from "node:test"
import { cleanCollectionLocation, collectionEditLocation, collectionSourceMatches, configEditLocation, readCollectionTarget } from "../src/shared/collectionTarget.ts"

const source = { name: "未应用 A.yaml", sha256: "a".repeat(64) }

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
