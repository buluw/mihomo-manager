import assert from "node:assert/strict"
import test from "node:test"
import type { RuntimeLoadState } from "../src/api/configClient.ts"
import { assertManagerSettingsTarget, managerSettingsTarget } from "../src/features/system/managerSettingsTarget.ts"

function loaded(name = "loaded.yaml", sha256 = "loaded-sha"): RuntimeLoadState {
  const generated = { schemaVersion: 1 as const, version: "generated-1", sourceName: name, sourceSha256: sha256, settingsVersion: 1, contentSha256: "runtime-sha", generatedAt: "now", path: "/runtime/generated.yaml" }
  return { schemaVersion: 1, version: 2, lastAttempt: { id: "attempt", generated, status: "succeeded", startedAt: "now", finishedAt: "now" }, lastSuccessful: { generated, loadedAt: "now" } }
}

test("settings follow confirmed loading independently of an editing preselection", () => {
  const state = loaded()
  assert.equal(managerSettingsTarget(state, "editing.yaml", false).name, "loaded.yaml")
  assert.equal(managerSettingsTarget(state, "", false).name, "loaded.yaml")
  assert.doesNotThrow(() => assertManagerSettingsTarget(state, "loaded.yaml"))
  assert.throws(() => assertManagerSettingsTarget(state, "editing.yaml"), /来源已变化/)
})

test("a settings or open field draft retains its source when loading changes", () => {
  const next = managerSettingsTarget(loaded("new.yaml"), "old.yaml", true)
  assert.equal(next.name, "old.yaml")
  assert.match(next.error!, /草稿仍属于原来源/)
  assert.equal(managerSettingsTarget(loaded("new.yaml"), "old.yaml", false).name, "new.yaml")
  const sameSource = managerSettingsTarget(loaded("old.yaml", "new-sha"), "old.yaml", true)
  assert.equal(sameSource.name, "old.yaml")
  assert.equal(sameSource.confirmed?.sha256, "new-sha")
})

test("unknown loading preserves an existing draft and never chooses a fallback", () => {
  const state = loaded()
  const states = [null, { ...state, lastAttempt: null }, ...["pending", "unknown"].map(status => ({ ...state, lastAttempt: { ...state.lastAttempt!, status } } as RuntimeLoadState))]
  for (const unknown of states) {
    assert.equal(managerSettingsTarget(unknown, "old.yaml", true).name, "old.yaml")
    assert.equal(managerSettingsTarget(unknown, "old.yaml", false).name, "")
    assert.throws(() => assertManagerSettingsTarget(unknown, "old.yaml"), /无法确认/)
  }
})
