import assert from "node:assert/strict"
import test from "node:test"

import { ConfigError, type ManagedProviderFileSnapshot, type ProviderCleanupItem } from "../src/api/configClient.ts"
import { cleanupPresentation, cleanupSelectionHint } from "../src/shared/collectionCleanup.ts"

test("cleanup display keeps recorded references separate from unknown dependencies", () => {
  const item: ProviderCleanupItem = { category: "proxy", fileName: "nodes.yaml", sha256: "file", identity: "identity", action: "keep", reason: "runtime_unknown",
    configReferences: [{ configName: "unreadable.yaml", kind: "unreadable" }],
    runtime: { references: [], uncertain: true, hasSuccessfulRecord: true, scanComplete: true, unknownReason: "core_unverified" } }
  const file = { category: "proxy" as const, fileName: "nodes.yaml", referencePath: "./providers/nodes.yaml", source: "local" as const, writable: false, sha256: "file", size: 1, updatedAt: "", filterSettings: null, extractionId: "fixture" }
  const view = cleanupPresentation(item, file)
  assert.deepEqual(view.configNames, [])
  assert.equal(view.configUnknown, true)
  assert.equal(view.recordLabel, "未发现引用")
  assert.equal(view.runtimeUnknown, true)
  assert.equal(view.source, "配置提取")
  assert.equal(view.maintained, true)
  assert.equal(cleanupPresentation(item, { ...file, sha256: "changed" }).source, "来源无法确认")
  assert.match(cleanupSelectionHint([item], [file]), /依赖无法确认.*自动维护/)
  const referenced = { ...item, configReferences: [{ configName: "main.yaml", kind: "identity" as const }], runtime: { ...item.runtime!, references: [{ kind: "path" as const, path: "./providers/nodes.yaml" }] } }
  assert.equal(cleanupPresentation(referenced).recordLabel, "有引用")
  assert.deepEqual(cleanupPresentation(referenced).configNames, ["main.yaml"])
  assert.match(cleanupSelectionHint([referenced]), /仍有引用/)
})
import { PROVIDER_OPERATION_TIMEOUT_MS } from "../src/api/controllerClient.ts"
import { declaredProxyProviderNames } from "../src/features/config-center/configActions.ts"
import { CollectionRequestController } from "../src/features/providers/collectionRequests.ts"
import { nextCollectionMobileDocument, nextCollectionMobileView } from "../src/features/providers/collectionViewModel.ts"
import { collectionEditorValidation } from "../src/features/providers/collectionViewModel.ts"
import {
  healthCheckCollectionProvider,
  collectionProviderRuntimeStatus,
  finalizeManagedProviderRemoval,
  mergeCollectionProviderTargets,
  readCollectionProvider,
  readCollectionProviders,
  syncAppliedProviderCategory,
  updateAndReadCollectionProviderStatuses,
  updateCollectionProvider,
  updateCollectionProviders,
  type CollectionControllerRequest,
} from "../src/features/providers/providerOperations.ts"

import { collectionProviderCounts, collectionRuntimeLists, type ProviderCategorySnapshot } from "../src/features/providers/collectionViewModel.ts"
import { disableMonacoCommandPalette, registerMonacoWordWrapShortcut, registerMonacoEditorShortcuts } from "../src/components/patterns/monacoActions.ts"
import {
  managedConfigIdentity,
  managedHttpOwnerChangeIds,
  externalManagedConfigDecision,
  managedPendingChangeIds,
  managedProviderDraftIssue,
  managedProviderDiscardState,
  managedProviderOperationPending,
  managedProviderRowOperationPending,
  managementBaselineKey,
  managementBaselineResourcesChanged,
  managementLifecycleState,
  managementLifecycleView,
  reduceManagementLifecycle,
  managedProviderFileHasDraft,
  managedCollectionBodyDrafts,
  reconcileManagedProviderDraft,
  reconcileManagedProviderTextEdit,
  resolveManagedProviderBaseline,
  updateInlineDraftState,
} from "../src/features/providers/managedProviderState.ts"
import {
  groupsEmptiedByRemoval,
  addHttpProviderConfig,
  updateInlineProviderContent,
  updateHttpProviderContent,
  validateInlineProviderDraft,
  updateManagedProviderConfig,
  deleteManagedProviderConfig,
  replaceCollectionUploadDeclaration,
} from "../src/features/providers/managedProviderYaml.ts"
import {
  managedHttpCatalog,
  desiredManagedHttpOwners,
  managedProviderDeclarationSnippet,
  managedProviderModificationReason,
  managedProviderContentKey,
  managedProviderItems,
  managedCollectionItems,
  httpIntervalSeconds,
  normalizeProviderFileName,
} from "../src/features/providers/managedProviderModel.ts"
import { selectCollectionSection } from "../src/features/providers/collectionViewModel.ts"
import { parse } from "yaml"
import { parseDocument } from "yaml"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

test("successful managed apply invalidates the selected source before refreshing only its category", async () => {
  const calls: string[] = []
  await syncAppliedProviderCategory(
    "proxy",
    "selected",
    (category, name) => calls.push(`invalidate:${category}:${name}`),
    async (category) => { calls.push(`load:${category}`) },
  )
  assert.deepEqual(calls, ["invalidate:proxy:selected", "load:proxy"])
})

test("target-level Provider map merge preserves unrelated rows and categories", () => {
  const proxy = { stable: { proxyCount: 1 }, adobe: { proxyCount: 2 } }
  const merged = mergeCollectionProviderTargets(proxy, { adobe: { proxyCount: 3 } })
  assert.deepEqual(merged, {
    stable: { proxyCount: 1 },
    adobe: { proxyCount: 3 },
  })
  const rule = { kept: { ruleCount: 4 } }
  assert.deepEqual(rule, { kept: { ruleCount: 4 } })
})

test("successful managed removal syncs only its runtime category and clears a deleted selection source", async () => {
  const calls: string[] = []
  const sourceCache = new Map([["proxy:deleted", "old content"], ["rule:kept", "rule content"]])
  const active = { proxy: "deleted", rule: "kept" }
  const maps = {
    proxy: { deleted: {}, fallback: {} },
    rule: { kept: {} },
  }
  const removal = await finalizeManagedProviderRemoval(
    "proxy",
    { name: "loaded.yaml", sha256: "b".repeat(64), path: "/fixture/loaded.yaml" },
    true,
    async (config) => { calls.push(`load-config:${config.name}:${config.sha256}`) },
  )
  assert.ok(removal.applied)
  await syncAppliedProviderCategory(
    removal.applied.category,
    active[removal.applied.category],
    (category, name) => {
      calls.push(`invalidate:${category}:${name}`)
      sourceCache.delete(`${category}:${name}`)
    },
    async (category) => {
      calls.push(`load:${category}`)
      maps[category] = { fallback: {} }
      active[category] = "fallback"
    },
  )
  assert.deepEqual(calls, [
    `load-config:loaded.yaml:${"b".repeat(64)}`,
    "invalidate:proxy:deleted",
    "load:proxy",
  ])
  assert.deepEqual(Object.keys(maps.proxy), ["fallback"])
  assert.deepEqual(Object.keys(maps.rule), ["kept"])
  assert.equal(active.proxy, "fallback")
  assert.equal(active.rule, "kept")
  assert.equal(sourceCache.has("proxy:deleted"), false)
  assert.equal(sourceCache.get("rule:kept"), "rule content")
})

test("HTTP removal waits for apply success while Controller load failure never exposes runtime sync", async () => {
  let loadAttempts = 0
  const syncCalls: string[] = []
  const draftRemoval = await finalizeManagedProviderRemoval(
    "rule",
    null,
    true,
    async () => { loadAttempts += 1 },
  )
  assert.equal(draftRemoval.applied, null)
  assert.equal(loadAttempts, 0)
  if (draftRemoval.applied) {
    await syncAppliedProviderCategory(
      draftRemoval.applied.category,
      "remote",
      (category, name) => syncCalls.push(`invalidate:${category}:${name}`),
      async (category) => { syncCalls.push(`load:${category}`) },
    )
  }
  assert.deepEqual(syncCalls, [])

  await syncAppliedProviderCategory(
    "rule",
    "remote",
    (category, name) => syncCalls.push(`invalidate:${category}:${name}`),
    async (category) => { syncCalls.push(`load:${category}`) },
  )
  assert.deepEqual(syncCalls, ["invalidate:rule:remote", "load:rule"])

  await assert.rejects(finalizeManagedProviderRemoval(
    "rule",
    { name: "loaded.yaml", sha256: "c".repeat(64), path: "/fixture/loaded.yaml" },
    true,
    async () => {
      loadAttempts += 1
      throw new Error("Controller load failed")
    },
  ), /Controller load failed/)
  assert.equal(loadAttempts, 1)

  const undeclaredRemoval = await finalizeManagedProviderRemoval(
    "proxy",
    { name: "loaded.yaml", sha256: "d".repeat(64), path: "/fixture/loaded.yaml" },
    false,
    async () => { loadAttempts += 1 },
  )
  assert.equal(undeclaredRemoval.applied, null)
  assert.equal(loadAttempts, 1)
})

test("collection mobile flow starts with the list and returns without losing selection", () => {
  let view = nextCollectionMobileView("editor", "category")
  assert.equal(view, "list")
  const selected = "provider-b"
  view = nextCollectionMobileView(view, "edit")
  assert.equal(view, "editor")
  view = nextCollectionMobileView(view, "back")
  assert.equal(view, "list")
  assert.equal(selected, "provider-b")
  let document = nextCollectionMobileDocument("payload", "edit")
  assert.equal(document, "yaml")
  document = nextCollectionMobileDocument(document, "payload")
  assert.equal(document, "payload")
  document = nextCollectionMobileDocument(document, "yaml")
  assert.equal(document, "yaml")

  assert.deepEqual(selectCollectionSection("proxy", "managed"), {
    category: "proxy",
    managed: true,
  })
  assert.deepEqual(selectCollectionSection("proxy", "rule"), {
    category: "rule",
    managed: false,
  })
  assert.deepEqual(selectCollectionSection("rule", "proxy"), {
    category: "proxy",
    managed: false,
  })
})

test("unified collections retain declared Inline and omit unrelated directory files", () => {
  const snapshot = {
    name: "loaded.yaml",
    path: "/fixture/loaded.yaml",
    sha256: "a".repeat(64),
    content: [
      "proxy-providers:",
      "  Inline:",
      "    type: inline",
      "    url: https://fixture.invalid/ignored",
      "    path: ./providers/Inline.yaml",
      "    payload: []",
      "  ExplicitHttp:",
      "    type: http",
      "    url: https://fixture.invalid/http",
      "    path: ./providers/http.yaml",
      "  LegacyHttp:",
      "    url: https://fixture.invalid/legacy",
      "    path: ./providers/legacy.yaml",
      "",
    ].join("\n"),
  }
  const files = [
    {
      fileName: "Inline.yaml", referencePath: "./providers/Inline.yaml", category: "proxy" as const,
      source: "manual" as const, writable: true, sha256: "b".repeat(64), size: 1,
      updatedAt: "", filterSettings: null, extractionId: null,
    },
    {
      fileName: "manual.yaml", referencePath: "./providers/manual.yaml", category: "proxy" as const,
      source: "manual" as const, writable: true, sha256: "c".repeat(64), size: 1,
      updatedAt: "", filterSettings: null, extractionId: null,
    },
  ]
  const ordinary = managedProviderItems(snapshot, files, "proxy")
  const managed = managedCollectionItems(snapshot, files, "proxy")
  const inline = ordinary.find((item) => item.name === "Inline")!
  assert.equal(inline.access, "inline")
  assert.equal(inline.writable, true)
  assert.equal(inline.id, "proxy:declaration:Inline")
  assert.equal(ordinary.find((item) => item.name === "ExplicitHttp")?.access, "http")
  assert.equal(ordinary.find((item) => item.name === "LegacyHttp")?.access, "http")
  assert.equal(managed.some((item) => item.name === "Inline"), true)
  assert.equal(managed.some((item) => item.name === "manual"), false)
  assert.equal(normalizeProviderFileName("new-provider"), "new-provider.yaml")
  assert.equal(normalizeProviderFileName("existing.yml"), "existing.yml")
  assert.equal(normalizeProviderFileName("existing.yaml"), "existing.yaml")

  const proxyHttp = addHttpProviderConfig(snapshot.content, "proxy", "remote", "https://fixture.invalid/proxy")
  assert.deepEqual(parse(proxyHttp.content)["proxy-providers"].remote, {
    type: "http",
    url: "https://fixture.invalid/proxy",
    path: "./providers/remote.yaml",
  })
  const ruleHttp = addHttpProviderConfig(snapshot.content, "rule", "remote-rules.yml", "https://fixture.invalid/rules", {
    version: 2, ruleBehavior: "domain", ruleFormat: "text", interval: 600, healthCheck: true,
  })
  assert.deepEqual(parse(ruleHttp.content)["rule-providers"]["remote-rules"], {
    type: "http",
    behavior: "domain",
    format: "text",
    url: "https://fixture.invalid/rules",
    path: "./ruleset/remote-rules.yml",
    interval: 600,
    "health-check": { enable: true, url: "http://www.gstatic.com/generate_204", interval: 300 },
  })
  assert.throws(
    () => addHttpProviderConfig(snapshot.content, "proxy", "Inline", "https://fixture.invalid/collision"),
    /同名 Provider/,
  )
  const ownedHttp = managedProviderItems(
    { ...snapshot, content: proxyHttp.content },
    files,
    "proxy",
    new Set(["remote"]),
  ).find((item) => item.name === "remote")!
  assert.equal(ownedHttp.writable, true)
  assert.throws(() => updateHttpProviderContent(proxyHttp.content, ownedHttp, "type: http\nurl:"), /url 和 path/)
  const editedHttp = updateHttpProviderContent(proxyHttp.content, ownedHttp, "type: http\nurl: https://fixture.invalid/new\npath: ./providers/remote.yaml\n")
  assert.equal(parse(editedHttp)["proxy-providers"].remote.url, "https://fixture.invalid/new")
  assert.deepEqual(collectionEditorValidation("Inline", "Inline", "Inline YAML 无法解析"), {
    error: "Inline YAML 无法解析",
    canSave: false,
  })
  assert.deepEqual(collectionEditorValidation("Inline", "Other", "Inline YAML 无法解析"), {
    error: null,
    canSave: false,
  })
  assert.deepEqual(collectionEditorValidation("Inline", "Inline", null), { error: null, canSave: true })
  assert.deepEqual(collectionEditorValidation(
    null,
    "Inline",
    null,
    "需要先在配置中心加载明确配置，才能编辑 Inline 集合",
  ), {
    error: "需要先在配置中心加载明确配置，才能编辑 Inline 集合",
    canSave: false,
  })
  assert.deepEqual(ordinary.filter((item) => item.writable).map((item) => item.name), ["Inline", "manual"])
})

test("managed baseline lifecycle preserves drafts, publishes clean snapshots atomically, and keeps pending controls stable", () => {
  const base = {
    id: "proxy:declaration:external",
    category: "proxy" as const,
    name: "external",
    fileName: null,
    referencePath: "./providers/external.yaml",
    access: "external" as const,
    writable: false,
    declared: true,
    declaration: { type: "file", path: "./providers/external.yaml" },
    content: "",
    sha256: null,
    filterSettings: null,
    extractionId: null,
    groups: ["AUTO"],
    selectedGroups: [],
    ruleSetRules: [],
  }
  const original = {
    loaded: false, selectedGroups: [], ruleSetRules: [], behavior: "classical", format: "yaml",
  }
  const changed = { ...original, loaded: true, selectedGroups: ["AUTO"] }
  assert.deepEqual([...managedPendingChangeIds({ [base.id]: changed }, { [base.id]: original })], [base.id])
  assert.equal(managedPendingChangeIds({ [base.id]: original }, { [base.id]: original }).size, 0)
  assert.deepEqual([...managedPendingChangeIds({}, {}, ["proxy:declaration:new"])], ["proxy:declaration:new"])
  const baselineKey = managementBaselineKey(true, "loaded.yaml", "a".repeat(64))!
  assert.equal(baselineKey, `management:loaded.yaml:${"a".repeat(64)}`)
  assert.equal(managementBaselineKey(true, "other.yaml", "a".repeat(64)) === baselineKey, false)
  assert.equal(managementBaselineKey(false, "loaded.yaml", "a".repeat(64)), null)
  const lifecycleBaseline = {
    snapshot: { name: "loaded.yaml", path: "/fixture/loaded.yaml", sha256: "a".repeat(64), content: "proxy-providers: {}\nrule-providers: {}\n" },
    files: [],
    httpOwners: [],
    controls: {
      "proxy:file:a.yaml": original,
      "rule:file:r.yaml": { ...original, loaded: true },
    },
  }
  let lifecycle = managementLifecycleState(null)
  assert.deepEqual(managementLifecycleView(lifecycle, false), {
    showSkeleton: true, preserveBaseline: false, writeDisabled: true, showMessage: true,
  })
  lifecycle = managementLifecycleState(lifecycleBaseline)
  assert.equal(Object.keys(lifecycle.baseline!.controls).filter((id) => id.startsWith("proxy:")).length, 1)
  assert.equal(Object.keys(lifecycle.baseline!.controls).filter((id) => id.startsWith("rule:")).length, 1)
  lifecycle = reduceManagementLifecycle(lifecycle, { type: "start", requestKey: baselineKey })
  assert.deepEqual(managementLifecycleView(lifecycle, false), {
    showSkeleton: false, preserveBaseline: true, writeDisabled: true, showMessage: true,
  })
  const changedBaseline = {
    ...lifecycleBaseline,
    snapshot: { ...lifecycleBaseline.snapshot, sha256: "c".repeat(64), content: "proxy-providers:\n  changed: { type: file, path: ./providers/changed.yaml }\n" },
  }
  const changedKey = managementBaselineKey(true, changedBaseline.snapshot.name, changedBaseline.snapshot.sha256)!
  const dirtyState = reduceManagementLifecycle(lifecycle, {
    type: "success", requestKey: baselineKey, loadedKey: changedKey, baselineKey: changedKey,
    baseline: changedBaseline, dirty: true, resourcesChanged: true,
  })
  assert.equal(dirtyState.baseline, lifecycleBaseline)
  assert.equal(dirtyState.status, "stale")
  assert.match(dirtyState.message, /保留当前未应用草稿|身份已变化/)
  const failedState = reduceManagementLifecycle(lifecycle, { type: "failure", requestKey: baselineKey, message: "读取失败" })
  assert.equal(failedState.baseline, lifecycleBaseline)
  assert.equal(failedState.message, "读取失败")
  assert.equal(managementLifecycleView(failedState, false).preserveBaseline, true)
  const externalConflict = reduceManagementLifecycle(lifecycle, {
    type: "external-conflict",
    message: "当前配置已被外部更新；已保留未应用草稿，请重新读取后处理冲突",
  })
  assert.equal(externalConflict.baseline, lifecycleBaseline)
  assert.equal(externalConflict.status, "stale")
  assert.match(externalConflict.message, /外部更新.*保留未应用草稿.*重新读取/)
  assert.deepEqual(managementLifecycleView(externalConflict, false), {
    showSkeleton: false, preserveBaseline: true, writeDisabled: true, showMessage: true,
  })
  const ownCommit = reduceManagementLifecycle(externalConflict, {
    type: "own-commit",
    baseline: changedBaseline,
  })
  assert.equal(ownCommit.baseline, changedBaseline)
  assert.equal(ownCommit.status, "ready")
  assert.equal(ownCommit.requestKey, null)
  assert.doesNotMatch(ownCommit.message, /保留当前未应用草稿/)
  const cleanLoaded = reduceManagementLifecycle(lifecycle, {
    type: "success", requestKey: baselineKey, loadedKey: baselineKey, baselineKey,
    baseline: lifecycleBaseline, dirty: false, resourcesChanged: false,
  })
  assert.equal(cleanLoaded.status, "ready")
  const nextRequest = reduceManagementLifecycle(cleanLoaded, { type: "start", requestKey: changedKey })
  const cleanChanged = reduceManagementLifecycle(nextRequest, {
    type: "success", requestKey: changedKey, loadedKey: changedKey, baselineKey: changedKey,
    baseline: changedBaseline, dirty: false, resourcesChanged: true,
  })
  assert.equal(cleanChanged.baseline, changedBaseline)
  assert.equal(cleanChanged.status, "ready")
  const late = reduceManagementLifecycle(cleanChanged, { type: "failure", requestKey: baselineKey, message: "迟到失败" })
  assert.equal(late, cleanChanged)

  const fileOnlyBaseline = {
    ...lifecycleBaseline,
    files: [{
      fileName: "renamed.yaml", referencePath: "./providers/renamed.yaml", category: "proxy" as const,
      source: "manual" as const, writable: true, sha256: "b".repeat(64), size: 1,
      updatedAt: "", filterSettings: null, extractionId: null,
    }],
  }
  assert.equal(managementBaselineResourcesChanged(lifecycleBaseline, fileOnlyBaseline), true)
  const draftControls = { ...lifecycleBaseline.controls, [base.id]: changed }
  const ownFileCreated = reduceManagementLifecycle(managementLifecycleState(lifecycleBaseline), {
    type: "own-commit", baseline: fileOnlyBaseline,
  })
  assert.equal(managementLifecycleView(ownFileCreated, false).writeDisabled, false)
  assert.equal(managedCollectionItems(ownFileCreated.baseline!.snapshot, ownFileCreated.baseline!.files, "proxy")
    .some((item) => item.fileName === "renamed.yaml"), false)
  assert.deepEqual([...managedPendingChangeIds(draftControls, ownFileCreated.baseline!.controls)], [base.id])
  assert.equal(ownFileCreated.baseline!.snapshot, lifecycleBaseline.snapshot)
  const externalAfterCreate = reduceManagementLifecycle(ownFileCreated, {
    type: "external-conflict", message: "external change while draft remains",
  })
  assert.equal(managementLifecycleView(externalAfterCreate, false).writeDisabled, true)
  assert.equal(externalAfterCreate.baseline, ownFileCreated.baseline)
  const sameShaDirtyResources = reduceManagementLifecycle(lifecycle, {
    type: "success", requestKey: baselineKey, loadedKey: baselineKey, baselineKey,
    baseline: fileOnlyBaseline, dirty: true, resourcesChanged: true,
  })
  assert.equal(sameShaDirtyResources.baseline, lifecycleBaseline)
  assert.equal(sameShaDirtyResources.status, "stale")
  assert.equal(managementLifecycleView(sameShaDirtyResources, false).writeDisabled, true)
  const diskDiverged = reduceManagementLifecycle(managementLifecycleState(fileOnlyBaseline), {
    type: "disk-diverged",
    baseline: lifecycleBaseline,
    message: "磁盘已更新但运行态不一致",
  })
  assert.equal(diskDiverged.baseline, lifecycleBaseline)
  assert.equal(diskDiverged.baseline?.files.some((file) => file.fileName === "renamed.yaml"), false)
  assert.equal(diskDiverged.status, "stale")
  assert.equal(managementLifecycleView(diskDiverged, false).writeDisabled, true)

  const snapshot = {
    name: "loaded.yaml",
    path: "/fixture/loaded.yaml",
    sha256: "a".repeat(64),
    content: "proxy-providers:\n  Other:\n    type: http\n    url: https://fixture.invalid/other\nproxy-groups:\n  - name: AUTO\n    type: select\n    use: []\n",
  }
  const files = [{
    fileName: "fixture.yaml", referencePath: "./providers/fixture.yaml", category: "proxy" as const,
    source: "manual" as const, writable: true, sha256: "b".repeat(64), size: 1,
    updatedAt: "", filterSettings: null, extractionId: null,
  }]
  const unloaded = managedProviderItems(snapshot, files, "proxy").find((item) => item.fileName === "fixture.yaml")!
  const unloadedControls = {
    loaded: false, selectedGroups: [], ruleSetRules: [], behavior: "classical", format: "yaml",
  }
  const loadedControls = { ...unloadedControls, loaded: true, selectedGroups: ["AUTO"] }
  const loadedContent = updateManagedProviderConfig(snapshot.content, unloaded, loadedControls)
  const loadedItem = managedProviderItems({ ...snapshot, content: loadedContent }, files, "proxy").find((item) => item.fileName === "fixture.yaml")!
  assert.equal(unloaded.id, "proxy:file:fixture.yaml")
  assert.equal(loadedItem.id, unloaded.id)
  assert.deepEqual([...managedPendingChangeIds(
    { [loadedItem.id]: loadedControls },
    { [unloaded.id]: unloadedControls },
  )], [unloaded.id])
  const revertedContent = updateManagedProviderConfig(loadedContent, loadedItem, unloadedControls)
  const revertedItem = managedProviderItems({ ...snapshot, content: revertedContent }, files, "proxy").find((item) => item.fileName === "fixture.yaml")!
  const revertedControls = { [revertedItem.id]: unloadedControls }
  const unloadedBaseline = { [unloaded.id]: unloadedControls }
  const restoredContent = managedPendingChangeIds(revertedControls, unloadedBaseline).size === 0
    ? snapshot.content
    : revertedContent
  const restoredItem = managedProviderItems({ ...snapshot, content: restoredContent }, files, "proxy").find((item) => item.fileName === "fixture.yaml")!
  assert.equal(restoredContent, snapshot.content)
  assert.equal(restoredItem.id, unloaded.id)
  assert.equal(managedPendingChangeIds(revertedControls, unloadedBaseline).size, 0)

  const loadedBaseline = { ...loadedControls }
  const removedContent = updateManagedProviderConfig(loadedContent, loadedItem, unloadedControls)
  const removedItem = managedProviderItems({ ...snapshot, content: removedContent }, files, "proxy").find((item) => item.fileName === "fixture.yaml")!
  assert.equal(removedItem.id, loadedItem.id)
  assert.equal(removedItem.declared, false)
  assert.equal(files.some((file) => file.fileName === "fixture.yaml"), true)
  assert.equal(parse(removedContent)["proxy-groups"][0].use, undefined)
  assert.equal(managedProviderDraftIssue(
    { [removedItem.id]: { ...loadedBaseline, loaded: false } },
    { proxy: [removedItem], rule: [] },
  ), null)
  const draftReloadedContent = updateManagedProviderConfig(removedContent, removedItem, loadedBaseline)
  const draftReloadedItem = managedProviderItems({ ...snapshot, content: draftReloadedContent }, files, "proxy").find((item) => item.fileName === "fixture.yaml")!
  const reloadedControls = { [draftReloadedItem.id]: loadedBaseline }
  const loadedBaselineControls = { [loadedItem.id]: loadedBaseline }
  const reloadedContent = managedPendingChangeIds(reloadedControls, loadedBaselineControls).size === 0
    ? loadedContent
    : draftReloadedContent
  const reloadedItem = managedProviderItems({ ...snapshot, content: reloadedContent }, files, "proxy").find((item) => item.fileName === "fixture.yaml")!
  assert.equal(reloadedContent, loadedContent)
  assert.equal(reloadedItem.id, loadedItem.id)
  assert.equal(managedPendingChangeIds(reloadedControls, loadedBaselineControls).size, 0)

  const sharedPathContent = [
    "proxy-providers:",
    "  fixture:",
    "    type: file",
    "    path: ./providers/fixture.yaml",
    "  AliasOne:",
    "    type: file",
    "    path: ./providers/fixture.yaml",
    "  AliasTwo:",
    "    type: file",
    "    path: ./providers/fixture.yaml",
    "proxy-groups:",
    "  - name: AUTO",
    "    type: select",
    "    use: [fixture, AliasOne, AliasTwo]",
    "",
  ].join("\n")
  const sharedItems = managedProviderItems({ ...snapshot, content: sharedPathContent }, files, "proxy")
  assert.deepEqual(sharedItems.map((item) => item.id).sort(), [
    "proxy:declaration:AliasOne",
    "proxy:declaration:AliasTwo",
    "proxy:file:fixture.yaml",
  ])
  assert.equal(new Set(sharedItems.map((item) => item.id)).size, 3)
  const aliasOne = sharedItems.find((item) => item.name === "AliasOne")!
  const aliasTwo = sharedItems.find((item) => item.name === "AliasTwo")!
  const withoutAliasOne = updateManagedProviderConfig(sharedPathContent, aliasOne, { loaded: false })
  const remainingAfterAliasOne = managedProviderItems({ ...snapshot, content: withoutAliasOne }, files, "proxy")
  assert.equal(remainingAfterAliasOne.some((item) => item.id === aliasOne.id), false)
  assert.equal(remainingAfterAliasOne.find((item) => item.name === "AliasTwo")?.id, aliasTwo.id)
  assert.deepEqual(parse(withoutAliasOne)["proxy-groups"][0].use, ["fixture", "AliasTwo"])
  const withoutAliasTwo = updateManagedProviderConfig(sharedPathContent, aliasTwo, { loaded: false })
  assert.equal(managedProviderItems({ ...snapshot, content: withoutAliasTwo }, files, "proxy")
    .find((item) => item.name === "AliasOne")?.id, aliasOne.id)
  assert.deepEqual(parse(withoutAliasTwo)["proxy-groups"][0].use, ["fixture", "AliasOne"])

  const canonical = sharedItems.find((item) => item.name === "fixture")!
  const withoutCanonical = updateManagedProviderConfig(sharedPathContent, canonical, { loaded: false })
  const aliasesAfterCanonical = managedProviderItems({ ...snapshot, content: withoutCanonical }, files, "proxy")
  assert.equal(aliasesAfterCanonical.find((item) => item.name === "AliasOne")?.id, aliasOne.id)
  assert.equal(aliasesAfterCanonical.find((item) => item.name === "AliasTwo")?.id, aliasTwo.id)

  const commit = { snapshotName: "loaded.yaml", commitName: "loaded.yaml", commitSha256: "b".repeat(64), loadedName: "loaded.yaml", loadedSha256: "b".repeat(64) }
  assert.equal(externalManagedConfigDecision({ ...commit, dirty: false }), "adopt")
  assert.equal(externalManagedConfigDecision({ ...commit, dirty: true }), "conflict")
  assert.equal(externalManagedConfigDecision({ ...commit, loadedSha256: "c".repeat(64), dirty: false }), "ignore")
})

test("current YAML reconciliation feeds structural controls without overwriting the draft", () => {
  const snapshot = {
    name: "loaded.yaml",
    path: "/fixture/loaded.yaml",
    sha256: "a".repeat(64),
    content: [
      "proxy-providers:",
      "  first:",
      "    type: http",
      "    url: https://fixture.invalid/first",
      "    path: ./providers/first.yaml",
      "    interval: 600",
      "    header: { X-Fixture: keep }",
      "    proxy: DIRECT",
      "    size-limit: 4096",
      "  second:",
      "    type: http",
      "    url: https://fixture.invalid/second",
      "    path: ./providers/second.yaml",
      "proxy-groups:",
      "  - name: AUTO",
      "    type: select",
      "    use: [first]",
      "",
    ].join("\n"),
  }
  const files = [
    { fileName: "first.yaml", referencePath: "./providers/first.yaml", category: "proxy" as const, source: "external" as const, writable: false, sha256: "b".repeat(64), size: 1, updatedAt: "", filterSettings: null, extractionId: null },
    { fileName: "second.yaml", referencePath: "./providers/second.yaml", category: "proxy" as const, source: "external" as const, writable: false, sha256: "c".repeat(64), size: 1, updatedAt: "", filterSettings: null, extractionId: null },
  ]
  const persistedOwners = managedHttpCatalog(snapshot, [])
  const editedContent = snapshot.content.replace("interval: 600", "interval: 3600").replace("use: [first]", "use: []")
  const editedSnapshot = { ...snapshot, content: editedContent }
  const reconciled = reconcileManagedProviderDraft(editedSnapshot, files, persistedOwners, managedProviderItems)
  const first = reconciled.itemsByCategory.proxy.find((item) => item.name === "first")!
  const second = reconciled.itemsByCategory.proxy.find((item) => item.name === "second")!
  const firstControls = reconciled.controls[first.id]
  const secondControls = reconciled.controls[second.id]
  assert.equal(firstControls.loaded, true)
  assert.deepEqual(firstControls.selectedGroups, [])
  assert.equal(firstControls.interval, 3600)
  assert.equal(secondControls.interval, null)

  const structurallyPatched = updateManagedProviderConfig(editedContent, first, { ...firstControls, selectedGroups: ["AUTO"] })
  const parsedPatched = parse(structurallyPatched) as Record<string, any>
  assert.deepEqual(parsedPatched["proxy-providers"].first, {
    type: "http",
    url: "https://fixture.invalid/first",
    path: "./providers/first.yaml",
    interval: 3600,
    header: { "X-Fixture": "keep" },
    proxy: "DIRECT",
    "size-limit": 4096,
  })
  assert.deepEqual(parsedPatched["proxy-groups"][0].use, ["first"])
  assert.deepEqual(parsedPatched["proxy-providers"].second, parse(editedContent)["proxy-providers"].second)

  const d0 = reconcileManagedProviderDraft(snapshot, files, persistedOwners, managedProviderItems)
  const d0Item = d0.itemsByCategory.proxy.find((item) => item.name === "first")!
  const d1Content = updateManagedProviderConfig(snapshot.content, d0Item, {
    ...d0.controls[d0Item.id],
    interval: 3600,
  })
  const d1 = reconcileManagedProviderDraft({ ...snapshot, content: d1Content }, files, d0.httpOwners, managedProviderItems)
  const d1Item = d1.itemsByCategory.proxy.find((item) => item.name === "first")!
  assert.equal(d1.controls[d1Item.id].interval, 3600)
  assert.equal(d1.httpOwners.find((owner) => owner.name === "first")?.declaration?.interval, 3600)
  assert.deepEqual(d1.httpOwners.find((owner) => owner.name === "first")?.declaration?.header, { "X-Fixture": "keep" })

  const d1UnloadedContent = updateManagedProviderConfig(d1Content, d1Item, { ...d1.controls[d1Item.id], loaded: false })
  const d1Unloaded = reconcileManagedProviderDraft({ ...snapshot, content: d1UnloadedContent }, files, d1.httpOwners, managedProviderItems)
  const d1UnloadedItem = d1Unloaded.itemsByCategory.proxy.find((item) => item.name === "first")!
  assert.equal(d1Unloaded.controls[d1UnloadedItem.id].loaded, false)
  assert.equal(d1Unloaded.httpOwners.find((owner) => owner.name === "first")?.declaration?.interval, 3600)

  const d1ReloadedContent = updateManagedProviderConfig(d1UnloadedContent, d1UnloadedItem, { ...d1Unloaded.controls[d1UnloadedItem.id], loaded: true })
  const d1Reloaded = reconcileManagedProviderDraft({ ...snapshot, content: d1ReloadedContent }, files, d1Unloaded.httpOwners, managedProviderItems)
  const d1ReloadedItem = d1Reloaded.itemsByCategory.proxy.find((item) => item.name === "first")!
  const reloadedDeclaration = (parse(d1ReloadedContent) as Record<string, any>)["proxy-providers"].first
  assert.equal(d1Reloaded.controls[d1ReloadedItem.id].loaded, true)
  assert.equal(d1Reloaded.controls[d1ReloadedItem.id].interval, 3600)
  assert.equal(reloadedDeclaration.interval, 3600)
  assert.deepEqual(reloadedDeclaration.header, { "X-Fixture": "keep" })
  assert.equal(reloadedDeclaration.proxy, "DIRECT")
  assert.equal(reloadedDeclaration["size-limit"], 4096)

  const invalidDraft = "proxy-providers: [\n"
  const invalidEdit = reconcileManagedProviderTextEdit(
    invalidDraft,
    d1Content,
    snapshot,
    files,
    d1.httpOwners,
    managedProviderItems,
  )
  assert.equal(invalidEdit.lastValidContent, d1Content)
  assert.match(invalidEdit.error ?? "", /flow sequence|YAML|end of the stream/i)
  assert.equal(invalidEdit.reconciled, null)
  assert.doesNotThrow(() => managedProviderItems(
    { ...snapshot, content: invalidEdit.lastValidContent },
    files,
    "proxy",
    d1.httpOwners,
  ))
  const lastValidDuringInvalid = managedProviderItems(
    { ...snapshot, content: invalidEdit.lastValidContent },
    files,
    "proxy",
    d1.httpOwners,
  ).find((item) => item.name === "first")!
  assert.equal(lastValidDuringInvalid.declaration?.interval, 3600)
  assert.equal(invalidDraft, "proxy-providers: [\n")

  const invalidAfterViewRoundTrip = reconcileManagedProviderTextEdit(
    invalidDraft,
    invalidEdit.lastValidContent,
    snapshot,
    files,
    d1.httpOwners,
    managedProviderItems,
  )
  assert.equal(invalidAfterViewRoundTrip.lastValidContent, d1Content)
  assert.equal(invalidAfterViewRoundTrip.reconciled, null)

  const correctedContent = d1Content.replace("interval: 3600", "interval: 21600")
  const correctedEdit = reconcileManagedProviderTextEdit(
    correctedContent,
    invalidAfterViewRoundTrip.lastValidContent,
    snapshot,
    files,
    d1.httpOwners,
    managedProviderItems,
  )
  assert.equal(correctedEdit.error, null)
  assert.equal(correctedEdit.lastValidContent, correctedContent)
  const correctedItem = correctedEdit.reconciled?.itemsByCategory.proxy.find((item) => item.name === "first")!
  assert.equal(correctedEdit.reconciled?.controls[correctedItem.id].interval, 21600)
  assert.equal(correctedEdit.reconciled?.httpOwners.find((owner) => owner.name === "first")?.declaration?.interval, 21600)

  const ruleSnapshot = {
    ...snapshot,
    content: [
      "rule-providers:",
      "  remote:",
      "    type: http",
      "    url: https://fixture.invalid/remote",
      "    path: ./ruleset/remote.yaml",
      "    interval: 600",
      "    format: yaml",
      "rules:",
      "  - RULE-SET,remote,DIRECT",
      "",
    ].join("\n"),
  }
  const ruleOwners = managedHttpCatalog(ruleSnapshot, [])
  const noRuleReference = ruleSnapshot.content.replace("  - RULE-SET,remote,DIRECT\n", "")
  const retainedDeclaration = reconcileManagedProviderDraft({ ...ruleSnapshot, content: noRuleReference }, [], ruleOwners, managedProviderItems)
  const retainedRule = retainedDeclaration.itemsByCategory.rule.find((item) => item.name === "remote")!
  assert.deepEqual(retainedDeclaration.controls[retainedRule.id].ruleSetRules, [])
  const retainedPatched = updateManagedProviderConfig(noRuleReference, retainedRule, { ...retainedDeclaration.controls[retainedRule.id], interval: 3600, format: "text" })
  assert.equal(parse(retainedPatched).rules?.some((rule: string) => rule.startsWith("RULE-SET,remote,")) ?? false, false)
  assert.equal(parse(retainedPatched)["rule-providers"].remote.interval, 3600)
  assert.equal(parse(retainedPatched)["rule-providers"].remote.format, "text")

  const declarationRemovedWithReference = ruleSnapshot.content.replace(/  remote:\n(?:    .*\n)+(?=rules:)/, "")
  const referencedOnly = reconcileManagedProviderDraft(
    { ...ruleSnapshot, content: declarationRemovedWithReference },
    [],
    ruleOwners,
    managedProviderItems,
  )
  const referencedOnlyRule = referencedOnly.itemsByCategory.rule.find((item) => item.name === "remote")!
  assert.equal(referencedOnly.controls[referencedOnlyRule.id].loaded, false)
  assert.deepEqual(referencedOnly.controls[referencedOnlyRule.id].ruleSetRules, ["RULE-SET,remote,DIRECT"])
  assert.equal(managedProviderDraftIssue(referencedOnly.controls, referencedOnly.itemsByCategory), null)
  const noDeclarationOrReference = noRuleReference.replace(/  remote:\n(?:    .*\n)+(?=rules:)/, "")
  const fullyRemoved = reconcileManagedProviderDraft({ ...ruleSnapshot, content: noDeclarationOrReference }, [], ruleOwners, managedProviderItems)
  const removedRule = fullyRemoved.itemsByCategory.rule.find((item) => item.name === "remote")!
  assert.equal(fullyRemoved.controls[removedRule.id].loaded, false)
  assert.deepEqual(fullyRemoved.controls[removedRule.id].ruleSetRules, [])
  assert.equal(managedProviderDraftIssue(fullyRemoved.controls, fullyRemoved.itemsByCategory), null)
})

test("declared manual removal adopts the deleted disk baseline when Controller load fails", async () => {
  const snapshot = {
    name: "loaded.yaml",
    path: "/fixture/loaded.yaml",
    sha256: "a".repeat(64),
    content: [
      "rule-providers:",
      "  remote: { type: file, path: ./ruleset/remote.yaml }",
      "rules:",
      "  - RULE-SET,remote,DIRECT",
      "  - MATCH,REJECT",
      "",
    ].join("\n"),
  }
  const diskFile = {
    fileName: "remote.yaml", referencePath: "./ruleset/remote.yaml", category: "rule" as const,
    source: "manual" as const, writable: true, sha256: "disk-file-sha", size: 1,
    updatedAt: "", filterSettings: null, extractionId: null,
  }
  const target = managedProviderItems(snapshot, [diskFile], "rule")
    .find((item) => item.name === "remote")!
  assert.equal(target.access, "manual")
  assert.equal(target.declared, true)
  const deletedSnapshot = {
    ...snapshot,
    sha256: "b".repeat(64),
    content: deleteManagedProviderConfig(snapshot.content, target),
  }
  const baseline = await resolveManagedProviderBaseline(
    deletedSnapshot,
    [diskFile],
    [],
    async () => [],
    async () => [],
    managedProviderItems,
  )
  assert.equal(baseline.snapshot.sha256, deletedSnapshot.sha256)
  assert.deepEqual(baseline.files, [])
  assert.equal(baseline.controls[target.id], undefined)
  assert.equal(managedProviderItems(baseline.snapshot, baseline.files, "rule").some((item) => item.name === target.name), false)

  let applied = null
  let controllerIdentity: { name: string; sha256: string } | null = {
    name: snapshot.name,
    sha256: snapshot.sha256,
  }
  let lifecycle = managementLifecycleState(null)
  try {
    const removal = await finalizeManagedProviderRemoval("rule", deletedSnapshot, true, async () => {
      throw new Error("Controller load failed")
    })
    applied = removal.applied
    controllerIdentity = { name: deletedSnapshot.name, sha256: deletedSnapshot.sha256 }
  } catch {
    controllerIdentity = null
    lifecycle = reduceManagementLifecycle(lifecycle, {
      type: "disk-diverged",
      baseline,
      message: "Provider 已删除且磁盘配置已更新，但 Controller 加载失败；两者当前不一致",
    })
  }
  const syncCalls: string[] = []
  if (applied) {
    await syncAppliedProviderCategory(
      applied.category,
      target.name,
      (category, name) => syncCalls.push(`invalidate:${category}:${name}`),
      async (category) => { syncCalls.push(`load:${category}`) },
    )
  }
  assert.equal(lifecycle.baseline, baseline)
  assert.equal(lifecycle.status, "stale")
  assert.equal(managementLifecycleView(lifecycle, false).writeDisabled, true)
  assert.match(lifecycle.message, /Provider 已删除.*Controller 加载失败/)
  assert.equal(applied, null)
  assert.deepEqual(syncCalls, [])
  assert.equal(controllerIdentity, null)
})

test("explicit discard restores all draft state to the latest successful baseline without I/O", () => {
  const snapshot = {
    name: "loaded.yaml",
    path: "/fixture/loaded.yaml",
    sha256: "a".repeat(64),
    content: [
      "proxy-providers:",
      "  proxy-file: { type: file, path: ./providers/proxy-file.yaml }",
      "proxy-groups:",
      "  - { name: AUTO, type: select, use: [proxy-file] }",
      "rule-providers:",
      "  remote: { type: http, url: https://fixture.invalid/rules, path: ./ruleset/remote.yaml, interval: 3600 }",
      "rules:",
      "  - RULE-SET,remote,DIRECT",
      "",
    ].join("\n"),
  }
  const files = [{
    fileName: "proxy-file.yaml", referencePath: "./providers/proxy-file.yaml", category: "proxy" as const,
    source: "manual" as const, writable: true, sha256: "file-sha", size: 1, updatedAt: "",
    filterSettings: null, extractionId: null,
  }]
  const owners = [{ configName: snapshot.name, category: "rule" as const, name: "remote", writable: true }]
  const reconciled = reconcileManagedProviderDraft(snapshot, files, owners, managedProviderItems)
  const baseline = {
    snapshot,
    files,
    httpOwners: reconciled.httpOwners,
    controls: reconciled.controls,
  }
  const proxyItem = reconciled.itemsByCategory.proxy[0]!
  const dirtyContent = updateManagedProviderConfig(snapshot.content, proxyItem, {
    ...reconciled.controls[proxyItem.id],
    loaded: false,
  })
  assert.notEqual(dirtyContent, snapshot.content)

  const reset = managedProviderDiscardState(baseline)
  const restored = reconcileManagedProviderDraft(
    { ...snapshot, content: reset.configContent },
    files,
    reset.httpOwners,
    managedProviderItems,
  )
  assert.equal(restored.itemsByCategory.proxy[0]?.declared, true)
  assert.deepEqual(restored.itemsByCategory.proxy[0]?.selectedGroups, ["AUTO"])
  assert.deepEqual(restored.itemsByCategory.rule[0]?.ruleSetRules, ["RULE-SET,remote,DIRECT"])
  assert.equal(managedPendingChangeIds(reset.controls, baseline.controls, managedHttpOwnerChangeIds(reset.httpOwners, baseline.httpOwners)).size, 0)
  assert.deepEqual({
    contents: reset.contents,
    savedContents: reset.savedContents,
    contentErrors: reset.contentErrors,
    declarationDrafts: reset.declarationDrafts,
    declarationErrors: reset.declarationErrors,
    configContentError: reset.configContentError,
  }, {
    contents: {}, savedContents: {}, contentErrors: {}, declarationDrafts: {}, declarationErrors: {}, configContentError: null,
  })

  const appliedSnapshot = { ...snapshot, sha256: "b".repeat(64), content: dirtyContent }
  const appliedDraft = reconcileManagedProviderDraft(appliedSnapshot, files, reconciled.httpOwners, managedProviderItems)
  const appliedReset = managedProviderDiscardState({
    snapshot: appliedSnapshot,
    files,
    httpOwners: appliedDraft.httpOwners,
    controls: appliedDraft.controls,
  })
  assert.equal(appliedReset.configContent, dirtyContent)
  assert.equal(appliedReset.controls[proxyItem.id]?.loaded, false)

})

test("Provider declaration snippets expose only the current named mapping", () => {
  const snapshot = {
    name: "loaded.yaml",
    path: "/config/loaded.yaml",
    sha256: "a".repeat(64),
    content: [
      "mixed-port: 7890",
      "proxy-providers:",
      "  first:",
      "    type: http",
      "    url: https://fixture.invalid/first",
      "    path: ./providers/first.yaml",
      "    interval: 600",
      "    health-check:",
      "      enable: true",
      "      url: https://fixture.invalid/check",
      "  second:",
      "    type: file",
      "    path: ./providers/second.yaml",
      "rule-providers:",
      "  rules:",
      "    type: http",
      "    behavior: domain",
      "    url: https://fixture.invalid/rules",
      "    path: ./ruleset/rules.yaml",
      "",
    ].join("\n"),
  }
  const proxyItem = managedProviderItems(snapshot, [], "proxy").find((item) => item.name === "first")!
  const snippet = managedProviderDeclarationSnippet(proxyItem)
  assert.deepEqual(Object.keys(parse(snippet)), ["first"])
  assert.equal(snippet.includes("mixed-port"), false)
  assert.equal(snippet.includes("second"), false)

  const ruleItem = managedProviderItems(snapshot, [], "rule").find((item) => item.name === "rules")!
  assert.deepEqual(Object.keys(parse(managedProviderDeclarationSnippet(ruleItem))), ["rules"])
})

test("shared Monaco removes the command palette while preserving native menu actions and disposal", () => {
  const copy = { id: "editor.action.clipboardCopyAction", label: "复制" }
  const format = { id: "editor.action.formatDocument", label: "设置文档格式" }
  const source = [format, { id: "vs.actions.separator" }, copy, { id: "vs.actions.separator" }, { id: "editor.action.quickCommand" }]
  const menu = { _getMenuActions: (...args: unknown[]) => { assert.deepEqual(args, ["current-model"]); return source } }
  const original = menu._getMenuActions
  let action: { id: string; keybindings: number[]; keybindingContext: string; run: () => void } | undefined
  const registration = disableMonacoCommandPalette({
    getContribution: (id) => { assert.equal(id, "editor.contrib.contextmenu"); return menu },
    addAction: (next) => { action = next; return { dispose: () => { action = undefined } } },
  }, { KeyCode: { F1: 59 } })
  assert.deepEqual(menu._getMenuActions("current-model"), [format, source[1], copy])
  assert.equal(source.length, 5)
  assert.equal(action?.id, "editor.action.quickCommand")
  assert.deepEqual(action?.keybindings, [59])
  assert.equal(action?.keybindingContext, "editorFocus")
  action!.run()
  registration.dispose()
  assert.equal(menu._getMenuActions, original)
  assert.equal(action, undefined)
})

test("shared Monaco word-wrap action updates actual options and follows their current state", () => {
  let action: { keybindings: number[]; label: string; contextMenuGroupId?: string; run: () => void } | undefined
  let wordWrap: "off" | "on" = "off"
  let changed = () => {}
  const registration = registerMonacoWordWrapShortcut(
    {
      addAction: (next) => { action = next; return { dispose() { action = undefined } } },
      getAction: () => null,
      getRawOptions: () => ({ wordWrap }),
      updateOptions: (options) => { wordWrap = options.wordWrap; changed() },
      onDidChangeConfiguration: (listener) => { changed = listener; return { dispose() { changed = () => {} } } },
    },
    { KeyMod: { Alt: 1 }, KeyCode: { KeyZ: 2 } },
  )
  assert.equal(action?.keybindings[0], 3)
  assert.equal(action?.contextMenuGroupId, "2_view")
  assert.equal(action?.label, "自动换行（已关闭）")
  action!.run()
  assert.equal(wordWrap, "on")
  assert.equal(action?.label, "自动换行（已开启）")
  const current = action
  changed()
  assert.equal(action, current)
  wordWrap = "off"; changed()
  assert.equal(action?.label, "自动换行（已关闭）")
  registration.dispose()
  assert.equal(action, undefined)
})

test("Monaco shortcuts follow current read-only state, language and save callback without registering again", () => {
  const executedActions: string[] = []
  const registeredCommands: Array<{ keybinding: number; handler: () => void }> = []
  let wordWrap: "off" | "on" = "off"
  let configurationChanged = () => {}
  const fakeEditor = {
    getRawOptions: () => ({ wordWrap }),
    updateOptions: (options: { wordWrap: "off" | "on" }) => { wordWrap = options.wordWrap; configurationChanged() },
    onDidChangeConfiguration: (listener: () => void) => { configurationChanged = listener; return { dispose() {} } },
    addAction: (action: { keybindings: number[]; keybindingContext: string; run: () => void }) => {
      assert.equal(action.keybindingContext, "editorTextFocus")
      const command = { keybinding: action.keybindings[0]!, handler: action.run }
      registeredCommands.push(command)
      return { dispose: () => { registeredCommands.splice(registeredCommands.indexOf(command), 1) } }
    },
    getAction: (id: string) => ({
      run: () => { executedActions.push(id) },
    }),
  }
  const fakeMonaco = {
    KeyMod: {
      CtrlCmd: 1 << 11,
      Alt: 1 << 9,
      Shift: 1 << 10,
      chord: (a: number, b: number) => a | (b << 16),
    },
    KeyCode: {
      KeyF: 1,
      KeyG: 2,
      KeyD: 3,
      KeyL: 4,
      KeyK: 5,
      KeyJ: 6,
      KeyS: 7,
      KeyZ: 8,
      KeyH: 9,
      KeyU: 10,
      KeyA: 11,
      Digit0: 12,
      Tab: 13,
      Enter: 14,
      Slash: 15,
      BracketLeft: 16,
      BracketRight: 17,
      UpArrow: 18,
      DownArrow: 19,
    },
  }

  const saves: string[] = []
  let options = { readOnly: true, language: "yaml", onSave: () => { saves.push("first") } }
  const registration = registerMonacoEditorShortcuts(fakeEditor, fakeMonaco, () => options)
  const commandCount = registeredCommands.length

  for (const cmd of [...registeredCommands]) {
    cmd.handler()
  }

  assert.ok(executedActions.includes("actions.find"), "只读模式应支持 actions.find (Ctrl+F)")
  assert.ok(executedActions.includes("editor.action.gotoLine"), "只读模式应支持 gotoLine (Ctrl+G)")
  assert.equal(wordWrap, "on", "只读模式应支持 Alt+Z 切换真实选项")
  assert.ok(executedActions.includes("editor.foldAll"), "只读模式应支持 foldAll")
  assert.ok(executedActions.includes("editor.unfoldAll"), "只读模式应支持 unfoldAll")

  assert.ok(!executedActions.includes("editor.action.deleteLines"))
  assert.ok(!executedActions.includes("editor.action.indentLines"))
  assert.ok(!executedActions.includes("editor.action.commentLine"))
  assert.ok(!executedActions.includes("editor.action.startFindReplaceAction"))
  assert.deepEqual(saves, [])

  executedActions.length = 0
  options = { readOnly: false, language: "yaml", onSave: () => { saves.push("current") } }

  for (const cmd of [...registeredCommands]) {
    cmd.handler()
  }

  assert.deepEqual(saves, ["current"])
  assert.ok(executedActions.includes("editor.action.deleteLines"), "可编辑模式应包含 deleteLines")
  assert.ok(executedActions.includes("editor.action.indentLines"), "可编辑模式应包含 indentLines")
  assert.ok(executedActions.includes("actions.find"), "可编辑模式同样支持 actions.find")
  assert.ok(executedActions.includes("editor.action.commentLine"))
  assert.ok(!executedActions.includes("editor.action.blockComment"))

  executedActions.length = 0
  options = { ...options, readOnly: true }
  for (const command of [...registeredCommands]) command.handler()
  assert.ok(executedActions.includes("actions.find"))
  assert.ok(!executedActions.includes("editor.action.deleteLines"))
  assert.ok(!executedActions.includes("editor.action.commentLine"))

  executedActions.length = 0
  options = { ...options, readOnly: false, language: "json" }
  for (const command of [...registeredCommands]) command.handler()
  assert.ok(executedActions.includes("editor.action.deleteLines"))
  assert.ok(executedActions.includes("editor.action.blockComment"))
  assert.equal(registeredCommands.length, commandCount)
  registration.dispose()
  assert.equal(registeredCommands.length, 0)
})

test("proxy and rule reads use independent latest-request lanes and dispose every request", async () => {
  const requests = new CollectionRequestController()
  const firstProxy = requests.beginCategory("proxy")
  const firstResult = deferred<string>()
  const published: string[] = []
  const firstPublication = firstResult.promise.then((value) => {
    if (firstProxy.isCurrent()) published.push(value)
  })
  const rule = requests.beginCategory("rule")
  const action = requests.beginAction()
  const secondProxy = requests.beginCategory("proxy")
  const secondResult = deferred<string>()
  const secondPublication = secondResult.promise.then((value) => {
    if (secondProxy.isCurrent()) published.push(value)
  })

  assert.equal(firstProxy.signal.aborted, true)
  assert.equal(firstProxy.isCurrent(), false)
  assert.equal(rule.signal.aborted, false)
  assert.equal(rule.isCurrent(), true)
  assert.equal(secondProxy.isCurrent(), true)

  secondResult.resolve("latest-proxy")
  firstResult.resolve("stale-proxy")
  await Promise.all([firstPublication, secondPublication])
  assert.deepEqual(published, ["latest-proxy"])

  requests.dispose()
  assert.equal(rule.signal.aborted, true)
  assert.equal(secondProxy.signal.aborted, true)
  assert.equal(action.signal.aborted, true)
  assert.equal(rule.isCurrent(), false)
  assert.equal(secondProxy.isCurrent(), false)

  const afterDispose = requests.beginCategory("proxy")
  const actionAfterDispose = requests.beginAction()
  assert.equal(afterDispose.signal.aborted, true)
  assert.equal(afterDispose.isCurrent(), false)
  assert.equal(actionAfterDispose.signal.aborted, true)
})

test("a single-provider publication supersedes an older list without cancelling other categories or actions", async () => {
  const requests = new CollectionRequestController()
  const stale = requests.beginCategory("proxy")
  const delayed = deferred<Record<string, { proxyCount: number }>>()
  let providers = { current: { proxyCount: 9 }, other: { proxyCount: 4 } }
  const completion = delayed.promise.then((result) => {
    if (stale.isCurrent()) providers = result as typeof providers
  }).finally(stale.finish)
  const rule = requests.beginCategory("rule")
  const action = requests.beginAction()
  const publication = requests.beginCategory("proxy")
  assert.equal(publication.finish(), true)
  providers = mergeCollectionProviderTargets(providers, { current: { proxyCount: 11 } }) as typeof providers
  delayed.resolve({ current: { proxyCount: 9 }, other: { proxyCount: 4 } })
  await completion
  assert.equal(providers.current.proxyCount, 11)
  assert.equal(providers.other.proxyCount, 4)
  assert.equal(stale.signal.aborted, true)
  assert.equal(rule.isCurrent(), true)
  assert.equal(action.signal.aborted, false)
  const later = requests.beginCategory("proxy")
  assert.equal(later.isCurrent(), true)
  requests.dispose()
  assert.equal(later.isCurrent(), false)
  assert.equal(action.signal.aborted, true)
  assert.equal(requests.beginCategory("proxy").finish(), false)
})

test("cancelled update-all clears progress before old operations settle without finishing the next source batch", async () => {
  const oldRequests = new CollectionRequestController()
  let progress: string | null = "A:0/2"
  const oldBatch = oldRequests.beginBatch(() => { progress = null })!
  const oldUpdates = deferred<void>()
  const oldCompletion = updateCollectionProviders("proxy", ["Shared", "AOnly"], oldBatch.signal,
    (completed, total) => { if (!oldBatch.signal.aborted) progress = `A:${completed}/${total}` },
    async () => oldUpdates.promise,
  ).finally(oldBatch.finish)
  assert.equal(oldRequests.batchRunning, true)

  oldRequests.dispose()
  assert.equal(oldBatch.signal.aborted, true)
  assert.equal(oldRequests.batchRunning, false)
  assert.equal(progress, null)
  assert.equal(oldRequests.beginBatch(() => { throw new Error("disposed pool cannot start a batch") }), null)

  const nextRequests = new CollectionRequestController()
  const nextBatch = nextRequests.beginBatch(() => { progress = null })!
  progress = "B:0/2"
  assert.equal(nextRequests.beginBatch(() => undefined), null)
  oldUpdates.resolve()
  await oldCompletion
  assert.equal(progress, "B:0/2")
  assert.equal(nextRequests.batchRunning, true)
  assert.equal(nextBatch.signal.aborted, false)

  nextBatch.finish()
  assert.equal(progress, null)
  assert.equal(nextRequests.batchRunning, false)
  const action = nextRequests.beginAction()
  assert.equal(action.signal.aborted, false)
  nextRequests.finishAction(action)
  nextRequests.dispose()
})

test("completed update-all releases its slot once and cannot clear a later batch in the same source", () => {
  const requests = new CollectionRequestController()
  let completions = 0
  const first = requests.beginBatch(() => { completions += 1 })!
  first.finish()
  const second = requests.beginBatch(() => { completions += 1 })!
  first.finish()
  assert.equal(completions, 1)
  assert.equal(requests.batchRunning, true)
  second.finish()
  assert.equal(completions, 2)
  assert.equal(requests.batchRunning, false)
  requests.dispose()
  assert.equal(completions, 2)
})

test("runtime collection counts use Controller maps while editing an empty configuration", () => {
  const providers = { proxy: { A: {}, B: {}, C: {}, D: {}, E: {} }, rule: { Rules: {} } }
  const managed = { proxy: [], rule: [] }
  assert.deepEqual(collectionProviderCounts(false, providers, managed), { proxy: 0, rule: 0 })
  assert.deepEqual(collectionProviderCounts(true, providers, managed), { proxy: 5, rule: 1 })
})

test("runtime source changes invalidate both categories before either new list can publish", () => {
  const snapshots: Record<"proxy" | "rule", ProviderCategorySnapshot> = {
    proxy: { sourceKey: "A:1", loading: false, providers: { Shared: {}, AOnly: {} } },
    rule: { sourceKey: "A:1", loading: false, providers: { Shared: {}, AOnly: {} } },
  }
  const pending = collectionRuntimeLists("B:1", snapshots)
  assert.deepEqual(pending.providerMaps, { proxy: {}, rule: {} })
  assert.deepEqual([...pending.loading], ["proxy", "rule"])
  snapshots.proxy = { sourceKey: "B:1", loading: false, providers: { Shared: {}, BOnly: {} } }
  const proxyReady = collectionRuntimeLists("B:1", snapshots)
  assert.equal(Object.keys(proxyReady.providerMaps.proxy).length, 2)
  assert.deepEqual(proxyReady.providerMaps.rule, {})
  assert.equal(proxyReady.loading.has("rule"), true)
  snapshots.rule = { sourceKey: "B:1", loading: false, providers: { Shared: {}, BOnly1: {}, BOnly2: {} } }
  const bothReady = collectionRuntimeLists("B:1", snapshots)
  assert.deepEqual(collectionProviderCounts(true, bothReady.providerMaps, { proxy: [], rule: [] }), { proxy: 2, rule: 3 })
  // A new version of the same source must invalidate the other category as well.
  snapshots.rule = { sourceKey: "B:2", loading: false, providers: { Shared: {} } }
  const ruleReady = collectionRuntimeLists("B:2", snapshots)
  assert.deepEqual(ruleReady.providerMaps.proxy, {})
  assert.equal(ruleReady.loading.has("proxy"), true)
  assert.deepEqual(Object.keys(ruleReady.providerMaps.rule), ["Shared"])
})

test("same-source refresh keeps the list visible with pending or error status but hides other sources", () => {
  for (const category of ["proxy", "rule"] as const) {
    for (const state of [{ loading: true }, { loading: false, error: "读取失败" }]) {
      const view = collectionRuntimeLists("B:1", {
        [category]: { sourceKey: "B:1", providers: { Old: {} }, ...state },
      })
      assert.deepEqual(view.providerMaps[category], { Old: {} })
      assert.deepEqual(collectionRuntimeLists("A:1", {
        [category]: { sourceKey: "B:1", providers: { Old: {} }, ...state },
      }).providerMaps[category], {})
      assert.equal(view.loading.has(category), state.loading)
      assert.equal(view.loadErrors[category], state.error)
    }
  }
})

test("replacing a runtime source cancels both category requests and rejects late old results", async () => {
  const oldRequests = new CollectionRequestController()
  const oldProxy = deferred<ProviderCategorySnapshot>()
  const oldRule = deferred<ProviderCategorySnapshot>()
  const snapshots: Partial<Record<"proxy" | "rule", ProviderCategorySnapshot>> = {}
  const publish = async (requests: CollectionRequestController, category: "proxy" | "rule", result: Promise<ProviderCategorySnapshot>) => {
    const request = requests.beginCategory(category)
    const snapshot = await result
    if (request.isCurrent()) snapshots[category] = snapshot
    request.finish()
    return request.signal.aborted
  }
  const oldReads = [publish(oldRequests, "proxy", oldProxy.promise), publish(oldRequests, "rule", oldRule.promise)]
  oldRequests.dispose()
  const nextRequests = new CollectionRequestController()
  await Promise.all((["proxy", "rule"] as const).map((category) => publish(nextRequests, category,
    Promise.resolve({ sourceKey: "B:2", providers: { New: {} }, loading: false }))))
  oldProxy.resolve({ sourceKey: "A:1", providers: { Old: {} }, loading: false })
  oldRule.resolve({ sourceKey: "A:1", providers: { Old: {} }, loading: false })
  assert.deepEqual(await Promise.all(oldReads), [true, true])
  const view = collectionRuntimeLists("B:2", snapshots)
  assert.deepEqual(view.providerMaps, { proxy: { New: {} }, rule: { New: {} } })
  assert.equal(view.loading.size, 0)
  nextRequests.dispose()
})

test("configd source failure degrades to right-pane state without blocking Controller data", async () => {
  const controllerReads: Array<{ path: string; signal: AbortSignal | null | undefined }> = []
  const proxyAbort = new AbortController()
  const snapshot = { name: "sample.yaml", path: "/controlled/sample.yaml", content: "mode: rule", sha256: "v1" }
  const source = await resolveManagedProviderBaseline(snapshot, [], [],
    async () => { throw new ConfigError("fixture unavailable", 0, "configd_unavailable") },
    async () => { throw new ConfigError("fixture unavailable", 0, "configd_unavailable") }, managedCollectionItems)
  const providers = await readCollectionProviders(
    "proxy",
    proxyAbort.signal,
    async (path, options) => {
      controllerReads.push({ path, signal: options?.signal })
      return {
        providers: {
          default: { vehicleType: "Compatible" },
          "automatic-group": { vehicleType: "Compatible", proxyCount: 2 },
          remote: { vehicleType: "HTTP", proxyCount: 2 },
        },
      }
    }
  )
  const ruleAbort = new AbortController()
  const ruleProviders = await readCollectionProviders(
    "rule",
    ruleAbort.signal,
    async (path, options) => {
      controllerReads.push({ path, signal: options?.signal })
      return { providers: { rules: { vehicleType: "File", ruleCount: 3 } } }
    }
  )

  assert.equal(source.snapshot, snapshot)
  assert.deepEqual(source.files, [])
  assert.deepEqual(source.httpOwners, [])
  assert.deepEqual(Object.keys(providers), ["remote"])
  assert.deepEqual(Object.keys(ruleProviders), ["rules"])
  assert.deepEqual(controllerReads, [
    { path: "/providers/proxies", signal: proxyAbort.signal },
    { path: "/providers/rules", signal: ruleAbort.signal },
  ])


})

test("single Provider refresh reads its native endpoint and merges only the requested result", async () => {
  const calls: string[] = []
  const signal = new AbortController().signal
  const request: CollectionControllerRequest = async (path, options) => {
    calls.push(path)
    assert.equal(options?.signal, signal)
    return path === "/providers/rules"
      ? { providers: { current: { ruleCount: 8 }, other: { ruleCount: 99 } } }
      : { proxyCount: 7 }
  }
  assert.deepEqual(await readCollectionProvider("proxy", "current/name", signal, request), { "current/name": { proxyCount: 7 } })
  const result = await readCollectionProvider("rule", "current", signal, request)
  assert.deepEqual(result, { current: { ruleCount: 8 } })
  assert.deepEqual(mergeCollectionProviderTargets({ current: { ruleCount: 1 }, other: { ruleCount: 2 } }, result),
    { current: { ruleCount: 8 }, other: { ruleCount: 2 } })
  assert.deepEqual(calls, ["/providers/proxies/current%2Fname", "/providers/rules"])
})

test("Provider actions preserve Mihomo native paths, methods, cancellation signals, and long update timeout", async () => {
  const calls: Array<{ path: string; options: RequestInit; timeoutMs?: number }> = []
  const request: CollectionControllerRequest = async (path, options = {}, timeoutMs) => {
    calls.push({ path, options, timeoutMs })
    return {}
  }
  const updateAbort = new AbortController()
  const checkAbort = new AbortController()

  await updateCollectionProvider("rule", "rules/remote", updateAbort.signal, request)
  await healthCheckCollectionProvider("proxy/remote", checkAbort.signal, request)

  assert.deepEqual(
    calls.map(({ path, options, timeoutMs }) => ({
      path,
      method: options.method,
      signal: options.signal,
      timeoutMs,
    })),
    [
      {
        path: "/providers/rules/rules%2Fremote",
        method: "PUT",
        signal: updateAbort.signal,
        timeoutMs: PROVIDER_OPERATION_TIMEOUT_MS,
      },
      {
        path: "/providers/proxies/proxy%2Fremote/healthcheck",
        method: undefined,
        signal: checkAbort.signal,
        timeoutMs: PROVIDER_OPERATION_TIMEOUT_MS,
      },
    ]
  )
  assert.equal(PROVIDER_OPERATION_TIMEOUT_MS > 6_000, true)
})

test("applied Provider target coordination updates only named category targets and classifies one failed update by readback", async () => {
  assert.equal(collectionProviderRuntimeStatus("proxy", { proxyCount: 44 }), "available")
  assert.equal(collectionProviderRuntimeStatus("proxy", { proxies: [], updatedAt: "0001-01-01T00:00:00Z" }), "declared")
  assert.equal(collectionProviderRuntimeStatus("proxy", { proxies: [] }, true), "failed")
  assert.equal(collectionProviderRuntimeStatus("proxy", { proxies: [], updatedAt: "2026-09-16T00:00:00Z" }), "available")
  const calls: Array<{ path: string; method: string | undefined; timeoutMs: number | undefined }> = []
  const request: CollectionControllerRequest = async (path, options = {}, timeoutMs) => {
    calls.push({ path, method: options.method, timeoutMs })
    if (options.method === "PUT" && path.endsWith("/retained")) throw new Error("fixture update failure")
    if (!options.method) {
      return { providers: { usable: { ruleCount: 12 }, retained: { ruleCount: 5234 }, empty: { ruleCount: 0 } } }
    }
    return {}
  }
  const result = await updateAndReadCollectionProviderStatuses(
    "rule",
    ["usable", "retained", "empty"],
    new AbortController().signal,
    (category, name, signal) => updateCollectionProvider(category, name, signal, request),
    (category, signal) => readCollectionProviders(category, signal, request),
  )
  assert.deepEqual(result.statuses, { usable: "available", retained: "update-failed", empty: "declared" })
  assert.deepEqual(result.providers, {
    usable: { ruleCount: 12 },
    retained: { ruleCount: 5234 },
    empty: { ruleCount: 0 },
  })
  assert.deepEqual([...result.updateFailedNames], ["retained"])
  assert.equal(result.verificationFailed, false)
  const settledStatuses = Object.fromEntries(Object.entries(result.statuses).map(([name, status]) => [
    name,
    result.providers[name] && status === "available" && result.updateFailedNames.has(name)
      ? "update-failed"
      : status,
  ]))
  assert.equal(settledStatuses.retained, "update-failed")
  assert.deepEqual(calls, [
    { path: "/providers/rules/usable", method: "PUT", timeoutMs: PROVIDER_OPERATION_TIMEOUT_MS },
    { path: "/providers/rules/retained", method: "PUT", timeoutMs: PROVIDER_OPERATION_TIMEOUT_MS },
    { path: "/providers/rules/empty", method: "PUT", timeoutMs: PROVIDER_OPERATION_TIMEOUT_MS },
    { path: "/providers/rules", method: undefined, timeoutMs: undefined },
  ])

  const unverified = await updateAndReadCollectionProviderStatuses(
    "proxy",
    ["only-target"],
    new AbortController().signal,
    async () => { throw new Error("fixture update and readback failure") },
    async () => { throw new Error("fixture readback failure") },
  )
  assert.deepEqual(unverified.statuses, {})
  assert.deepEqual([...unverified.updateFailedNames], ["only-target"])
  assert.equal(unverified.verificationFailed, true)
})

test("collection update all isolates failures, reports progress, and leaves one refresh to the caller", async () => {
  const calls: string[] = []
  const progress: Array<[number, number]> = []
  let refreshes = 0
  const result = await updateCollectionProviders(
    "rule",
    ["alpha", "broken", "omega"],
    new AbortController().signal,
    (completed, total) => progress.push([completed, total]),
    async (category, name, signal) => {
      calls.push(`${category}:${name}:${signal.aborted}`)
      if (name === "broken") throw new Error("fixture failure")
    },
  )
  refreshes += 1

  assert.deepEqual(result, { success: 2, failed: 1 })
  assert.deepEqual(calls, ["rule:alpha:false", "rule:broken:false", "rule:omega:false"])
  assert.deepEqual(progress.map(([completed]) => completed).sort((a, b) => a - b), [1, 2, 3])
  assert.equal(progress.every(([, total]) => total === 3), true)
  assert.equal(refreshes, 1)
})

test("managed collections preserve access ordering and build one explicit config draft", () => {
  const snapshot = {
    name: "loaded.yaml",
    path: "/fixture/loaded.yaml",
    sha256: "sha-loaded",
    content: [
      "proxy-providers:",
      "  Keep: &keep # declaration comment",
      "    type: file # type comment",
      "    path: ./providers/keep.yaml",
      "  Copy: *keep",
      "  Zebra:",
      "    type: http",
      "    url: https://fixture.invalid/provider",
      "  Inline:",
      "    type: inline",
      "    payload: []",
      "  宝贝云:",
      "    type: inline",
      "    proxies: []",
      "proxy-groups:",
      "  - name: Main",
      "    type: select",
      "    use: [Legacy]",
      "rule-providers:",
      "  Rules:",
      "    type: file",
      "    behavior: classical # behavior comment",
      "    format: yaml # format comment",
      "    path: ./ruleset/Rules.yaml",
      "rules:",
      "  - RULE-SET,Rules,DIRECT",
      "  - MATCH,DIRECT",
      "",
    ].join("\n"),
  }
  const files = [
    { fileName: "alpha.yaml", referencePath: "./providers/alpha.yaml", category: "proxy" as const, source: "manual" as const, writable: true, sha256: "sha-a", size: 10, updatedAt: "2026-08-12T00:00:00.000Z", filterSettings: null, extractionId: null },
    { fileName: "Rules.yaml", referencePath: "./ruleset/Rules.yaml", category: "rule" as const, source: "manual" as const, writable: true, sha256: "sha-r", size: 10, updatedAt: "2026-08-12T00:00:00.000Z", filterSettings: null, extractionId: null },
    { fileName: "detached.yaml", referencePath: "./ruleset/detached.yaml", category: "rule" as const, source: "manual" as const, writable: true, sha256: "sha-d", size: 10, updatedAt: "2026-08-12T00:00:00.000Z", filterSettings: null, extractionId: null },
    { fileName: "external.yaml", referencePath: "./providers/external.yaml", category: "proxy" as const, source: "external" as const, writable: false, sha256: "sha-e", size: 10, updatedAt: "2026-08-12T00:00:00.000Z", filterSettings: null, extractionId: null },
    { fileName: "local.yaml", referencePath: "./providers/local.yaml", category: "proxy" as const, source: "local" as const, writable: false, sha256: "sha-l", size: 10, updatedAt: "2026-08-12T00:00:00.000Z", filterSettings: { version: 1, enabled: true, rules: ["notice"] }, extractionId: "local-relation" },
  ]

  const proxies = managedProviderItems(snapshot, files, "proxy")
  assert.deepEqual(proxies.map((item) => [item.name, item.access, item.writable]), [
    ["宝贝云", "inline", true],
    ["alpha", "manual", true],
    ["Inline", "inline", true],
    ["Copy", "external", false],
    ["external", "external", false],
    ["Keep", "external", false],
    ["local", "local", false],
    ["Zebra", "http", false],
  ])
  assert.equal(managedConfigIdentity(snapshot, "loaded.yaml", "sha-loaded"), true)
  assert.equal(managedConfigIdentity(snapshot, "loaded.yaml", "stale-sha"), false)

  const inline = proxies.find((item) => item.name === "Inline")!
  const babyCloud = proxies.find((item) => item.name === "宝贝云")!
  assert.equal(inline.content.trim(), "payload: []")
  assert.equal(babyCloud.content.trim(), "proxies: []")
  assert.equal(snapshot.content.includes("payload: []"), true)
  assert.equal(snapshot.content.includes("proxies: []"), true)

  const invalidDraft = validateInlineProviderDraft(snapshot.content, babyCloud, "proxies:")
  assert.equal(invalidDraft.content, null)
  assert.match(invalidDraft.error ?? "", /payload 或 proxies 数组/)
  const malformedDraft = validateInlineProviderDraft(snapshot.content, babyCloud, "proxies: [")
  assert.equal(malformedDraft.content, null)
  assert.match(malformedDraft.error ?? "", /YAML 无法解析/)

  let inlineDraftState = updateInlineDraftState(snapshot.content, {}, {}, babyCloud, "proxies:")
  assert.equal(inlineDraftState.configContent, snapshot.content)
  assert.equal(inlineDraftState.contents[babyCloud.id], "proxies:")
  assert.match(inlineDraftState.errors[babyCloud.id] ?? "", /payload 或 proxies 数组/)

  // A delayed editor event remains bound to A even after B has become the selection.
  inlineDraftState = updateInlineDraftState(
    inlineDraftState.configContent,
    inlineDraftState.contents,
    inlineDraftState.errors,
    inline,
    "payload:\n  - name: delayed-a\n",
  )
  assert.equal(inlineDraftState.contents[babyCloud.id], "proxies:")
  assert.equal(inlineDraftState.errors[babyCloud.id] !== null, true)
  assert.match(inlineDraftState.contents[inline.id] ?? "", /delayed-a/)
  assert.deepEqual(parse(inlineDraftState.configContent)["proxy-providers"].Inline.payload, [
    { name: "delayed-a" },
  ])
  assert.deepEqual(parse(inlineDraftState.configContent)["proxy-providers"]["宝贝云"].proxies, [])

  inlineDraftState = updateInlineDraftState(
    inlineDraftState.configContent,
    inlineDraftState.contents,
    inlineDraftState.errors,
    babyCloud,
    "proxies:\n  - name: fixed-b\n",
  )
  assert.equal(inlineDraftState.errors[babyCloud.id], null)
  assert.deepEqual(parse(inlineDraftState.configContent)["proxy-providers"]["宝贝云"].payload, [
    { name: "fixed-b" },
  ])
  assert.equal(parse(inlineDraftState.configContent)["proxy-providers"]["宝贝云"].proxies, undefined)
  assert.doesNotThrow(() => updateInlineProviderContent(
    inlineDraftState.configContent,
    inline,
    "payload:\n  - name: payload-ok\n",
  ))

  const manual = proxies.find((item) => item.access === "manual")!
  const enabled = updateManagedProviderConfig(snapshot.content, manual, {
    loaded: true,
    selectedGroups: ["Main"],
  })
  const enabledConfig = parse(enabled)
  assert.deepEqual([...declaredProxyProviderNames(enabled)].sort(), ["Copy", "Inline", "Keep", "Zebra", "alpha", "宝贝云"])
  assert.deepEqual(enabledConfig["proxy-providers"].alpha, {
    type: "file",
    path: "./providers/alpha.yaml",
  })
  assert.deepEqual(enabledConfig["proxy-groups"][0].use, ["Legacy", "alpha"])
  const local = proxies.find((item) => item.access === "local")!
  assert.equal(local.extractionId, "local-relation")
  assert.deepEqual(parse(updateManagedProviderConfig(snapshot.content, local, {
    loaded: true,
    selectedGroups: ["Main"],
  }))["proxy-groups"][0].use, ["Legacy", "local"])
  const collidingFile = { ...manual, id: "proxy:file:Zebra.yaml", name: "Zebra", fileName: "Zebra.yaml", referencePath: "./providers/Zebra.yaml", declared: false }
  assert.throws(() => updateManagedProviderConfig(snapshot.content, collidingFile, {
    loaded: true,
    selectedGroups: ["Main"],
  }), /同名 Provider 声明/)
  assert.equal(parse(updateManagedProviderConfig(snapshot.content, collidingFile, { loaded: false }))["proxy-providers"].Zebra.type, "http")

  const keep = proxies.find((item) => item.name === "Keep")!
  const keepGroups = updateManagedProviderConfig(snapshot.content, keep, {
    loaded: true,
    selectedGroups: ["Main"],
  })
  assert.match(keepGroups, /# declaration comment/)
  assert.match(keepGroups, /# type comment/)
  assert.match(keepGroups, /&keep/)
  assert.match(keepGroups, /Copy: \*keep/)
  const keepConfig = parse(keepGroups)
  assert.deepEqual(keepConfig["proxy-providers"].Copy, keepConfig["proxy-providers"].Keep)
  assert.deepEqual(keepConfig["proxy-groups"][0].use, ["Legacy", "Keep"])

  const ruleItems = managedProviderItems(snapshot, files, "rule")
  const rule = ruleItems.find((item) => item.name === "Rules")!
  const detachedRule = ruleItems.find((item) => item.name === "detached")!
  assert.equal(detachedRule.referencePath, "./ruleset/detached.yaml")
  assert.equal(parse(updateManagedProviderConfig(snapshot.content, detachedRule, { loaded: true }))["rule-providers"].detached.path, "./ruleset/detached.yaml")
  const changedRule = updateManagedProviderConfig(snapshot.content, rule, {
    loaded: true,
    behavior: "domain",
    format: "text",
    ruleSetRules: rule.ruleSetRules,
  })
  const revertedRule = updateManagedProviderConfig(changedRule, rule, {
    loaded: true,
    behavior: "classical",
    format: "yaml",
    ruleSetRules: rule.ruleSetRules,
  })
  const revertedRuleConfig = parse(revertedRule)
  assert.equal(revertedRuleConfig["rule-providers"].Rules.behavior, "classical")
  assert.equal(revertedRuleConfig["rule-providers"].Rules.format, "yaml")
  assert.match(revertedRule, /# behavior comment/)
  assert.match(revertedRule, /# format comment/)

  const ruleUnloadedContent = updateManagedProviderConfig(snapshot.content, rule, { loaded: false })
  const ruleUnloaded = parse(ruleUnloadedContent)
  assert.equal(ruleUnloaded["rule-providers"], undefined)
  assert.deepEqual(ruleUnloaded.rules, ["RULE-SET,Rules,DIRECT", "MATCH,DIRECT"])
  const recoveredRule = managedCollectionItems({ ...snapshot, content: ruleUnloadedContent }, files, "rule", new Set(), snapshot)
    .find((item) => item.fileName === rule.fileName)!
  assert.equal(recoveredRule.declared, false)
  assert.deepEqual(recoveredRule.ruleSetRules, rule.ruleSetRules)
  assert.equal(recoveredRule.id, rule.id)
  const unloadedRuleControls = {
    loaded: false,
    selectedGroups: [],
    ruleSetRules: rule.ruleSetRules,
    behavior: "classical",
    format: "yaml",
    interval: null,
  }
  assert.equal(unloadedRuleControls.loaded, false)
  assert.deepEqual(unloadedRuleControls.ruleSetRules, ["RULE-SET,Rules,DIRECT"])
  const unloadIssue = managedProviderDraftIssue({
    [rule.id]: { ...unloadedRuleControls, ruleSetRules: [] },
  }, { proxy: [], rule: [recoveredRule] })
  assert.equal(unloadIssue, null)

  const deleteSource = snapshot.content.replace(
    "  - RULE-SET,Rules,DIRECT\n",
    "  - RULE-SET,Rules,DIRECT\n  - RULE-SET,Other,REJECT\n  - RULE-SET,Rules,PROXY,no-resolve\n",
  )
  for (const access of ["manual", "http"] as const) {
    const deletedRule = parse(deleteManagedProviderConfig(deleteSource, { ...rule, access }))
    assert.equal(deletedRule["rule-providers"]?.Rules, undefined)
    assert.deepEqual(deletedRule.rules, ["RULE-SET,Other,REJECT", "MATCH,DIRECT"])
  }

})

test("unloaded HTTP catalog entries restore full declarations and human intervals", () => {
  const snapshot = {
    name: "loaded.yaml",
    path: "/fixture/loaded.yaml",
    sha256: "sha-loaded",
    content: [
      "rule-providers:",
      "  remote:",
      "    type: http",
      "    behavior: domain",
      "    format: mrs",
      "    url: https://fixture.invalid/rules",
      "    path: ./ruleset/remote.yaml",
      "    interval: 3600",
      "    header: { X-Fixture: retained }",
      "    proxy: DIRECT",
      "rules:",
      "  - RULE-SET,remote,DIRECT",
      "",
    ].join("\n"),
  }
  const declaration = {
    type: "http",
    behavior: "domain",
    format: "mrs",
    url: "https://fixture.invalid/rules",
    path: "./ruleset/remote.yaml",
    interval: 3600,
    header: { "X-Fixture": "retained" },
    proxy: "DIRECT",
  }
  const persistedOwners = [{ configName: snapshot.name, category: "rule" as const, name: "remote", declaration }]
  const ownedDraft = reconcileManagedProviderDraft(snapshot, [], persistedOwners, managedProviderItems)
  const ownedItem = ownedDraft.itemsByCategory.rule[0]!
  assert.equal(ownedItem.writable, true)
  const ownedUnloadedContent = updateManagedProviderConfig(snapshot.content, ownedItem, {
    ...ownedDraft.controls[ownedItem.id],
    loaded: false,
  })
  const ownedUnloadedDraft = reconcileManagedProviderDraft(
    { ...snapshot, content: ownedUnloadedContent },
    [],
    ownedDraft.httpOwners,
    managedProviderItems,
  )
  const ownedUnloadedItem = ownedUnloadedDraft.itemsByCategory.rule[0]!
  assert.equal(ownedUnloadedDraft.httpOwners[0]?.writable, true)
  assert.equal(ownedUnloadedItem.writable, true)
  assert.equal(ownedUnloadedItem.declared, false)
  assert.deepEqual(desiredManagedHttpOwners(ownedUnloadedDraft.itemsByCategory.rule), [{ category: "rule", name: "remote" }])
  const ownedReloadedContent = updateManagedProviderConfig(ownedUnloadedContent, ownedUnloadedItem, {
    ...ownedUnloadedDraft.controls[ownedUnloadedItem.id],
    loaded: true,
  })
  const ownedReloadedDraft = reconcileManagedProviderDraft(
    { ...snapshot, content: ownedReloadedContent },
    [],
    ownedUnloadedDraft.httpOwners,
    managedProviderItems,
  )
  assert.equal(ownedReloadedDraft.itemsByCategory.rule[0]?.declared, true)
  assert.equal(ownedReloadedDraft.itemsByCategory.rule[0]?.writable, true)
  assert.deepEqual(desiredManagedHttpOwners(ownedReloadedDraft.itemsByCategory.rule), [{ category: "rule", name: "remote" }])
  const owners = managedHttpCatalog(snapshot, [])
  assert.equal(owners.length, 1)
  assert.equal(owners[0]?.writable, false)
  assert.deepEqual(owners[0]?.declaration, declaration)
  const savedOwners = structuredClone(owners)
  const files = [{
    fileName: "remote.yaml", referencePath: "./ruleset/remote.yaml", category: "rule" as const,
    source: "external" as const, writable: false, sha256: "sha-cache", size: 1,
    updatedAt: "", filterSettings: null, extractionId: null,
  }]
  const initialDraft = reconcileManagedProviderDraft(snapshot, files, owners, managedProviderItems)
  const initialItems = initialDraft.itemsByCategory.rule
  assert.equal(initialItems.length, 1)
  const item = initialItems[0]!
  assert.equal(item.access, "http")
  assert.equal(item.declared, true)
  assert.equal(item.writable, false)
  assert.deepEqual(desiredManagedHttpOwners(initialItems), [])
  const baselineControls = {
    loaded: true,
    selectedGroups: [],
    ruleSetRules: item.ruleSetRules,
    behavior: "domain",
    format: "mrs",
    interval: 3600,
  }
  const unloaded = updateManagedProviderConfig(snapshot.content, item, { ...baselineControls, loaded: false })
  const restoredDraft = reconcileManagedProviderDraft(
    { ...snapshot, content: unloaded },
    files,
    initialDraft.httpOwners,
    managedProviderItems,
  )
  const restoredItems = restoredDraft.itemsByCategory.rule
  assert.equal(restoredItems.length, 1)
  const restored = restoredItems[0]!
  assert.equal(restoredDraft.httpOwners[0]?.writable, false)
  assert.equal(restored.declared, false)
  assert.equal(restored.access, "http")
  assert.equal(restored.writable, false)
  assert.equal(restored.id, item.id)
  assert.deepEqual(restored.declaration, declaration)
  assert.deepEqual(restored.ruleSetRules, [])
  assert.deepEqual(desiredManagedHttpOwners(restoredItems), [])
  const unloadedControls = { ...baselineControls, loaded: false }
  assert.equal(managedPendingChangeIds({ [item.id]: unloadedControls }, { [item.id]: baselineControls }).size, 1)
  assert.equal(managedProviderDraftIssue(
    { [item.id]: { ...unloadedControls, ruleSetRules: [] } },
    { proxy: [], rule: [restored] },
  ), null)

  const reloadedContent = updateManagedProviderConfig(unloaded, restored, baselineControls)
  const reloadedDraft = reconcileManagedProviderDraft(
    { ...snapshot, content: reloadedContent },
    files,
    restoredDraft.httpOwners,
    managedProviderItems,
  )
  const reloadedControls = { [item.id]: baselineControls }
  assert.equal(managedPendingChangeIds(reloadedControls, { [item.id]: baselineControls }).size, 0)
  assert.equal(reloadedDraft.httpOwners[0]?.writable, false)
  assert.equal(reloadedDraft.itemsByCategory.rule[0]?.writable, false)
  assert.deepEqual(desiredManagedHttpOwners(reloadedDraft.itemsByCategory.rule), [])
  const restoredConfig = JSON.stringify(owners) === JSON.stringify(savedOwners) &&
    managedPendingChangeIds(reloadedControls, { [item.id]: baselineControls }).size === 0
    ? snapshot.content
    : reloadedContent
  assert.equal(restoredConfig, snapshot.content)
  assert.deepEqual(owners, savedOwners)
  assert.equal(httpIntervalSeconds(90, "minutes"), 5_400)
  assert.equal(httpIntervalSeconds(1.5, "hours"), 5_400)
  assert.equal(httpIntervalSeconds(2, "days"), 172_800)
  assert.throws(() => httpIntervalSeconds(0, "minutes"), /必须大于 0/)
  const pendingRows = new Set(["provider-a"])
  assert.equal(managedProviderOperationPending("provider-a", pendingRows, new Set(), new Set()), true)
  assert.equal(managedProviderOperationPending("provider-b", pendingRows, new Set(), new Set()), false)
  assert.equal(managedProviderOperationPending("provider-b", new Set(), new Set(["provider-b"]), new Set()), true)

  assert.equal(managedProviderModificationReason({ ...ownedItem, access: "http", writable: true }), null)
  assert.equal(managedProviderModificationReason({ ...ownedItem, access: "http", writable: false }), "此 HTTP 集合不由管理器创建，不能删除")
  assert.equal(managedProviderModificationReason({ ...ownedItem, access: "external", writable: false }), "文件不属于管理器，允许编辑但不能删除文件")
  assert.equal(managedProviderModificationReason({ ...ownedItem, access: "inline", declared: true }), null)
  assert.equal(managedProviderModificationReason({ ...ownedItem, access: "subscription", writable: false }), "无法确认自动提取 Provider 的所有权")

  const reloaded = parse(updateManagedProviderConfig(unloaded, restored, { ...baselineControls, interval: null }))["rule-providers"].remote
  assert.equal(reloaded.interval, undefined)
  assert.deepEqual(reloaded.header, declaration.header)
  assert.equal(reloaded.proxy, "DIRECT")
})

test("owned source files are deletable and HTTP rename drafts keep one stable row identity", () => {
  const sourceBase = {
    id: "proxy:file:owned.yaml", category: "proxy" as const, name: "owned", fileName: "owned.yaml",
    referencePath: "./providers/owned.yaml", writable: false, declared: false, declaration: null,
    content: "", sha256: "sha", filterSettings: null, extractionId: null, groups: [], selectedGroups: [], ruleSetRules: [],
  }
  assert.equal(managedProviderModificationReason({ ...sourceBase, access: "local" as const, ownerId: "local-owner" }), null)
  assert.equal(managedProviderModificationReason({ ...sourceBase, access: "subscription" as const, ownerId: "subscription-owner" }), null)
  assert.match(managedProviderModificationReason({ ...sourceBase, access: "local" as const, ownerId: null }) ?? "", /无法确认/)
  assert.match(managedProviderModificationReason({ ...sourceBase, access: "external" as const, ownerId: null }) ?? "", /不属于管理器/)

  const snapshot = {
    name: "active.yaml", path: "/data/active.yaml", sha256: "config-sha", size: 1, updatedAt: "",
    content: [
      "rule-providers:",
      "  original:",
      "    type: http",
      "    url: https://fixture.invalid/rules",
      "    path: ./ruleset/original.yaml",
      "rules:",
      "  - RULE-SET,original,DIRECT",
      "  - MATCH,DIRECT",
      "",
    ].join("\n"),
  }
  const owners = [{
    configName: snapshot.name, category: "rule" as const, name: "original", writable: true,
    declaration: { type: "http", url: "https://fixture.invalid/rules", path: "./ruleset/original.yaml" },
  }, {
    configName: snapshot.name, category: "rule" as const, name: "unloaded", writable: true,
    declaration: { type: "http", url: "https://fixture.invalid/unloaded", path: "./ruleset/unloaded.yaml" },
  }]
  const cacheFiles = [{
    fileName: "original.yaml", referencePath: "./ruleset/original.yaml", category: "rule" as const,
    source: "external" as const, writable: false, sha256: "cache-sha", size: 1, updatedAt: "",
    filterSettings: null, extractionId: null, ownerId: null,
  }, {
    fileName: "unloaded.yaml", referencePath: "./ruleset/unloaded.yaml", category: "rule" as const,
    source: "external" as const, writable: false, sha256: "unloaded-cache-sha", size: 1, updatedAt: "",
    filterSettings: null, extractionId: null, ownerId: null,
  }]
  const initial = reconcileManagedProviderDraft(snapshot, cacheFiles, owners, managedProviderItems)
  const unrelated = initial.itemsByCategory.rule.find((item) => item.name === "unloaded")!
  assert.equal(initial.controls[unrelated.id]?.loaded, false)
  const firstContent = snapshot.content.replaceAll("original", "renamed")
  const first = reconcileManagedProviderDraft({ ...snapshot, content: firstContent }, cacheFiles, owners, managedProviderItems)
  assert.equal(first.itemsByCategory.rule.length, 2)
  const firstRenamed = first.itemsByCategory.rule.find((item) => item.name === "renamed")!
  const firstUnrelated = first.itemsByCategory.rule.find((item) => item.name === "unloaded")!
  assert.deepEqual({ id: firstRenamed.id, name: firstRenamed.name, origin: firstRenamed.draftOriginName }, {
    id: "rule:declaration:original", name: "renamed", origin: "original",
  })
  const firstOwnerChanges = managedHttpOwnerChangeIds(first.httpOwners, initial.httpOwners)
  assert.deepEqual(firstOwnerChanges, ["rule:declaration:original"])
  assert.equal(managedPendingChangeIds(first.controls, initial.controls, firstOwnerChanges).size, 1)
  assert.equal(managedProviderRowOperationPending(firstRenamed, new Set(firstOwnerChanges), new Set(), new Set()), false)
  assert.equal(managedProviderRowOperationPending(firstUnrelated, new Set(firstOwnerChanges), new Set(), new Set()), false)
  assert.match(managedProviderDeclarationSnippet(firstRenamed), /^renamed:/)

  const secondContent = firstContent.replaceAll("renamed", "final")
  const second = reconcileManagedProviderDraft({ ...snapshot, content: secondContent }, cacheFiles, first.httpOwners, managedProviderItems)
  assert.equal(second.itemsByCategory.rule.length, 2)
  const secondRenamed = second.itemsByCategory.rule.find((item) => item.name === "final")!
  assert.deepEqual({ id: secondRenamed.id, name: secondRenamed.name, origin: secondRenamed.draftOriginName }, {
    id: "rule:declaration:original", name: "final", origin: "original",
  })
  const deleted = parse(deleteManagedProviderConfig(secondContent, secondRenamed))
  assert.equal(deleted["rule-providers"], undefined)
  assert.deepEqual(deleted.rules, ["MATCH,DIRECT"])
})

function collectionBodyDraftFixture() {
  const snapshot = {
    name: "loaded.yaml", path: "/fixture/loaded.yaml", sha256: "config-sha",
    content: [
      "rule-providers:",
      "  manual: { type: file, behavior: domain, path: ./ruleset/manual.yaml }",
      "  external: { type: file, behavior: domain, path: ./ruleset/external.yaml }",
      "  remote: { type: http, behavior: domain, path: ./ruleset/remote.yaml, url: https://fixture.invalid/rules }",
      "  inline: { type: inline, behavior: domain, payload: [fixture.invalid] }",
      "rules:",
      "  - RULE-SET,manual,DIRECT",
      "  - RULE-SET,external,DIRECT",
      "  - RULE-SET,remote,DIRECT",
      "  - RULE-SET,inline,DIRECT",
      "",
    ].join("\n"),
  }
  const files: ManagedProviderFileSnapshot[] = ["manual", "external"].map((name) => ({
    fileName: `${name}.yaml`, referencePath: `./ruleset/${name}.yaml`, category: "rule",
    source: name === "manual" ? "manual" : "external", writable: true,
    sha256: `${name}-saved-sha`, size: 40, updatedAt: "", filterSettings: null, extractionId: null,
    content: `payload:\n  - ${name}.fixture.invalid\n`,
  }))
  const owners = managedHttpCatalog(snapshot, [{ configName: snapshot.name, category: "rule", name: "remote" }])
  const items = managedProviderItems(snapshot, files, "rule", owners)
  const ordinary = items.filter((item) => item.access === "manual" || item.access === "external")
  return {
    snapshot, files, owners, items, ordinary,
  }
}

test("shared File aliases keep one body draft and independent declarations in workspace saves", () => {
  const { snapshot, files } = collectionBodyDraftFixture()
  const shared = { ...snapshot, content: snapshot.content.replace("rule-providers:\n", [
    "rule-providers:",
    "  alias: { type: file, behavior: domain, path: ruleset/manual.yaml }",
    "",
  ].join("\n")) }
  const items = managedProviderItems(shared, files, "rule")
  const original = items.find((item) => item.name === "manual")!
  const alias = items.find((item) => item.name === "alias")!
  const independent = items.find((item) => item.name === "external")!
  assert.notEqual(original.id, alias.id)
  assert.equal(managedProviderContentKey(original), managedProviderContentKey(alias))
  assert.notEqual(managedProviderContentKey(original), managedProviderContentKey(independent))
  const bodies = Object.fromEntries(files.map(file => [managedProviderContentKey(items.find(item => item.fileName === file.fileName)!), file.content]))
  const edited = { ...bodies, [managedProviderContentKey(original)]: "payload:\n  - changed.fixture.invalid\n" }
  assert.equal(edited[managedProviderContentKey(alias)], edited[managedProviderContentKey(original)])
  assert.equal(edited[managedProviderContentKey(independent)], bodies[managedProviderContentKey(independent)])
  const targets = managedCollectionBodyDrafts(items, edited, bodies)
  assert.deepEqual(targets.map(item => item.name).sort(), ["alias", "manual"])
  assert.ok(targets.every(body => body.content === edited[managedProviderContentKey(original)] && body.expectedSha256 === original.sha256))

  const savedFiles = files.map((file) => file.fileName === original.fileName
    ? { ...file, sha256: "saved-next", content: edited[managedProviderContentKey(original)]! } : file)
  const refreshed = managedProviderItems(shared, savedFiles, "rule")
  const nextOriginal = refreshed.find((item) => item.name === "manual")!
  const nextAlias = refreshed.find((item) => item.name === "alias")!
  assert.equal(nextOriginal.sha256, "saved-next")
  assert.equal(nextAlias.sha256, nextOriginal.sha256)
  assert.deepEqual(managedCollectionBodyDrafts(refreshed, edited, edited), [])
  const secondDraft = { ...edited, [managedProviderContentKey(nextAlias)]: "payload:\n  - second.fixture.invalid\n" }
  assert.equal(secondDraft[managedProviderContentKey(nextOriginal)], secondDraft[managedProviderContentKey(nextAlias)])
  const nextBodies = managedCollectionBodyDrafts(refreshed, secondDraft, edited)
  assert.deepEqual(nextBodies.map(item => item.name).sort(), ["alias", "manual"])
  assert.ok(nextBodies.every(body => body.expectedSha256 === "saved-next"))

  const withoutAlias = updateManagedProviderConfig(shared.content, alias, { loaded: false })
  assert.ok(parse(withoutAlias)["rule-providers"].manual)
  assert.equal(parse(withoutAlias)["rule-providers"].alias, undefined)
  assert.notEqual(managedProviderContentKey({ ...alias, access: "http" }), managedProviderContentKey(original))
  assert.notEqual(managedProviderContentKey({ ...alias, access: "local", writable: false }), managedProviderContentKey(original))
  assert.notEqual(managedProviderContentKey({ ...alias, category: "proxy" }), managedProviderContentKey(original))
})

test("file refresh protects same-file drafts while independent bodies remain refreshable", () => {
  const { snapshot, files } = collectionBodyDraftFixture()
  const items = managedProviderItems(snapshot, files, "rule")
  const original = items.find((item) => item.name === "manual")!
  const independent = items.find((item) => item.name === "external")!
  const alias = { ...original, id: "rule:alias", name: "alias", referencePath: "ruleset/manual.yaml" }
  const readonlyAlias = { ...alias, id: "rule:readonly-alias", name: "readonly-alias", access: "local" as const, writable: false }
  const all = [...items, alias, readonlyAlias]
  const saved = { ...Object.fromEntries(files.map(file => [managedProviderContentKey(items.find(item => item.fileName === file.fileName)!), file.content])), [readonlyAlias.id]: original.content }
  const draft = { ...saved, [managedProviderContentKey(original)]: "payload: [changed.fixture.invalid]" }
  const none = new Set<string>()
  const blocked = (item: typeof original, contents = draft, pending = none, declarations = none) =>
    managedProviderFileHasDraft(item, all, contents, saved, pending, declarations)
  assert.equal(blocked(independent), false)
  assert.equal(blocked(original), true)
  assert.equal(blocked(alias), true)
  assert.equal(blocked(readonlyAlias), true)
  assert.equal(blocked(alias, saved), false)
  assert.equal(blocked(original, saved, new Set([alias.id])), true)
  assert.equal(blocked(original, saved, none, new Set([alias.id])), true)
  assert.equal(blocked(independent, saved, none, new Set([alias.id])), false)
  assert.equal(blocked(original, { ...saved, [readonlyAlias.id]: "changed readonly fixture" }), true)
  assert.equal(blocked({ ...original, category: "proxy" }), false)
  assert.equal(original.sha256, files.find((file) => file.fileName === original.fileName)!.sha256)
  assert.equal(draft[managedProviderContentKey(original)], "payload: [changed.fixture.invalid]")
})

test("collection removal drafts expose groups losing their final source for application diagnostics", () => {
  const content = 'proxy-providers:\n  only: {type: inline, payload: []}\nproxy-groups:\n  - {name: empty-after, type: select, use: [only]}\n  - {name: direct-remains, type: select, use: [only], proxies: [DIRECT]}\n  - {name: all-providers, type: select, include-all-providers: true}\n  - {name: core-fallback, type: select, include-all-proxies: true, use: [only]}\n  - {name: preexisting-empty, type: select}\n';
  const item = managedProviderItems({ name: 'test.yaml', path: '', sha256: 'fixture', content }, [], 'proxy')[0]!;
  assert.deepEqual(groupsEmptiedByRemoval(content, item), ['empty-after', 'all-providers']);
  const removed = parse(deleteManagedProviderConfig(content, item));
  assert.equal(removed['proxy-providers']?.only, undefined);
  assert.ok(!removed['proxy-groups'][0].use?.includes('only'));
  const safe = content.replace('use: [only]', 'use: [only], proxies: [DIRECT]').replace('include-all-providers: true', 'include-all: true');
  assert.doesNotThrow(() => deleteManagedProviderConfig(safe, item));
});

test("unfinished inline and declaration text persists inside only its named source section", async () => {
  const { replaceProviderDrafts, inlineProviderDraftText } = await import("../src/features/providers/managedProviderYaml.ts")
  const snapshot = { name: "fixture.yaml", sha256: "fixture", path: "/configs/fixture.yaml", content:
    "mode: direct\nproxy-providers:\n  first: {type: inline, payload: []}\n  second: {type: inline, payload: []}\nrules: [MATCH,DIRECT]\n" }
  const [first, second] = managedProviderItems(snapshot, [], "proxy")
  const saved = replaceProviderDrafts(snapshot.content, [
    { item: first!, snippet: inlineProviderDraftText(first!, "proxies: [unfinished") },
    { item: second!, snippet: "second:\n  type: [" },
  ])
  assert.match(saved, /mode: direct/)
  assert.match(saved, /payload: \[unfinished/)
  assert.match(saved, /second:\n    type: \[/)
  assert.match(saved, /rules:/)
})


test("missing collection editors retain both category drafts in one workspace save", () => {
  const content = 'proxy-providers:\n  one: {type: file, path: ./one.yaml}\nrule-providers:\n  two: {type: file, behavior: classical, path: ./two.yaml}\n'
  const snapshot = { name: "new.yaml", path: "", sha256: "a".repeat(64), content,
    collectionPaths: [
      { category: "proxy" as const, name: "one", sourcePath: "./one.yaml", fileName: "config-0123456789abcdef01234567/one.yaml", referencePath: "./providers/config-0123456789abcdef01234567/one.yaml", status: "missing" as const },
      { category: "rule" as const, name: "two", sourcePath: "./two.yaml", fileName: "config-0123456789abcdef01234567/two.yaml", referencePath: "./ruleset/config-0123456789abcdef01234567/two.yaml", status: "missing" as const },
    ] }
  const proxy = managedProviderItems(snapshot, [], "proxy")[0]!
  const rule = managedProviderItems(snapshot, [], "rule")[0]!
  assert.equal(proxy.writable, true)
  assert.equal(rule.writable, true)
  let contents = { [managedProviderContentKey(proxy)]: "proxies: [\n" }
  contents = { ...contents, [managedProviderContentKey(rule)]: "payload: []\n" }
  const bodies = managedCollectionBodyDrafts([proxy, rule], contents, {})
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0]!.content, "proxies: [\n")
  assert.equal(bodies[0]!.expectedSha256, null)
  assert.deepEqual(managedCollectionBodyDrafts([proxy, rule], contents, {}, [{ category: "proxy", name: "one" }]), [bodies[1]])
  const protectedSnapshot = { ...snapshot, collectionPaths: snapshot.collectionPaths.map((entry) => ({ ...entry, writable: false })) }
  assert.equal(managedProviderItems(protectedSnapshot, [], "proxy")[0]!.writable, false)
})

test("mapped collection body reads use the selected source directory", () => {
  const path = "./providers/config-0123456789abcdef01234567/shared.yaml"
  const file = { fileName: "config-0123456789abcdef01234567/shared.yaml", referencePath: path, category: "proxy" as const,
    source: "manual" as const, writable: true, sha256: "b".repeat(64), size: 1, updatedAt: "", filterSettings: null, extractionId: null, ownerId: null }
  const snapshot = { name: "source.yaml", path: "", sha256: "a".repeat(64), content: 'proxy-providers:\n  one: {type: file, path: ./shared.yaml}\n',
    collectionPaths: [{ category: "proxy" as const, name: "one", sourcePath: "./shared.yaml", fileName: file.fileName, referencePath: path }] }
  const item = managedProviderItems(snapshot, [file], "proxy")[0]!
  assert.equal(item.fileName, file.fileName)
  assert.equal(item.sha256, file.sha256)
  const other = { ...file, fileName: file.fileName.replace("0123456789abcdef01234567", "111111111111111111111111"), referencePath: path.replace("0123456789abcdef01234567", "111111111111111111111111") }
  assert.equal(managedProviderItems(snapshot, [other], "proxy").find((item) => item.name === "one")!.sha256, null)
})


test("uploaded declarations and deletion update direct and compound rule references in the source draft", () => {
  const content = 'rule-providers:\n  local: {type: file, behavior: classical, path: ./local.yaml}\nrules:\n  - RULE-SET,local,DIRECT\n  - AND,((RULE-SET,local),(NETWORK,TCP)),DIRECT\n  - MATCH,DIRECT\nsub-rules:\n  nested:\n    - RULE-SET,local,DIRECT\n    - DOMAIN,example.invalid,DIRECT\n'
  const snapshot = { name: "source.yaml", path: "", sha256: "a".repeat(64), content }
  const item = managedProviderItems(snapshot, [], "rule").find((entry) => entry.name === "local")!
  const renamed = parse(replaceCollectionUploadDeclaration(content, item, "renamed", { ...item.declaration, path: "./renamed.yaml" }))
  assert.equal(renamed["rule-providers"].local, undefined)
  assert.equal(renamed["rule-providers"].renamed.path, "./renamed.yaml")
  assert.ok(renamed.rules[1].includes("RULE-SET,renamed"))
  assert.equal(renamed["sub-rules"].nested[0], "RULE-SET,renamed,DIRECT")
  const removed = parse(deleteManagedProviderConfig(content, item))
  assert.deepEqual(removed.rules, ["MATCH,DIRECT"])
  assert.deepEqual(removed["sub-rules"].nested, ["DOMAIN,example.invalid,DIRECT"])
})

test("workspace body drafts track ordinary files, saved baselines and pending removals", () => {
  const { files, items, ordinary } = collectionBodyDraftFixture()
  const saved = Object.fromEntries(files.map(file => [managedProviderContentKey(items.find(item => item.fileName === file.fileName)!), file.content]))
  const changed = ordinary[0]!
  const contents = { ...saved, [managedProviderContentKey(changed)]: "payload: [changed.fixture.invalid]" }
  const expected = [{ category: changed.category, name: changed.name, content: contents[managedProviderContentKey(changed)], expectedSha256: changed.sha256 }]
  assert.deepEqual(managedCollectionBodyDrafts(items, contents, saved), expected)
  assert.deepEqual(managedCollectionBodyDrafts(items, contents, contents), [])
  assert.deepEqual(managedCollectionBodyDrafts(items, contents, saved, [{ category: changed.category, name: changed.name }]), [])
  assert.deepEqual(managedCollectionBodyDrafts(items.map(item => item.id === changed.id ? { ...item, pendingRemoval: true } : item), contents, saved), [])
  const sourceBodies = Object.fromEntries(items.filter(item => item.access === "http" || item.access === "inline").map(item => [managedProviderContentKey(item), "payload: [source.fixture.invalid]"]))
  assert.deepEqual(managedCollectionBodyDrafts(items, { ...contents, ...sourceBodies }, saved), expected)
})
