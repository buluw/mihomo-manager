import assert from "node:assert/strict"
import test from "node:test"

import { PageRefreshRegistry } from "../src/app/pageRefreshRegistry.ts"
import { ProxyRequestController } from "../src/features/proxies/proxyRuntime.ts"
import { ProxySelectionCoordinator } from "../src/features/proxies/proxySelectionCoordinator.ts"
import { ProxyNodeInfoLifecycle, ProxyNodeInfoLifecycleHost, publishProxyNodeInfoSettings, saveBoundProxyNodeInfo } from "../src/features/proxies/proxyNodeInfoLifecycle.ts"
import { actualProxyLeafName, mergeProxyProviderNodes, proxyNodeInfoTarget } from "../src/features/proxies/proxyLogic.ts"
import { proxyIdentityKey } from "../src/features/proxies/proxyMergeSettings.ts"
import { commitRuleEditorRefresh, createRuleEditorValue } from "../src/features/rules/ruleEditorState.ts"
import { RuleRequestLifecycle } from "../src/features/rules/ruleRequestLifecycle.ts"
import { configRuleItems } from "../src/features/rules/ruleViewModel.ts"
import { AbortableRequestPool, LatestRequestController } from "../src/shared/requestLifecycle.ts"
import {
  removeSubscriptionSnapshot,
  upsertSubscriptionSnapshot,
} from "../src/features/config-center/subscriptionWorkspaceState.ts"

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

test("page refresh registry runs only the currently mounted page handler", async () => {
  const registry = new PageRefreshRegistry()
  const calls: string[] = []
  const removeFirst = registry.register(() => { calls.push("first") })
  const removeSecond = registry.register(async () => { calls.push("second") })

  removeFirst()
  await registry.run()
  removeSecond()
  await registry.run()

  assert.deepEqual(calls, ["second"])
})

test("proxy node info request lanes bind snapshots to the latest node, session, and config", async () => {
  const lifecycle = new ProxyNodeInfoLifecycle()
  const mountSettings = lifecycle.beginSettings()!
  const generation = lifecycle.openSession("provider-a\0node-a")
  const openSettings = lifecycle.beginSettings(generation)!
  assert.equal(mountSettings.signal.aborted, true)
  assert.equal(mountSettings.isCurrent(), false)
  assert.equal(openSettings.isCurrent(), true)

  const configA = lifecycle.beginConfig("a.yaml")!
  const configB = lifecycle.beginConfig("b.yaml")!
  assert.equal(configA.signal.aborted, true)
  assert.equal(configA.isCurrent(), false)
  assert.equal(configA.finish(), false)
  assert.equal(configB.isCurrent(), true)
  const bindingB = lifecycle.snapshotBinding()
  assert.deepEqual(bindingB, {
    generation,
    identityKey: "provider-a\0node-a",
    configName: "b.yaml",
  })

  lifecycle.selectIdentity("provider-b\0node-b")
  assert.equal(configB.signal.aborted, true)
  assert.equal(configB.isCurrent(), false)
  assert.equal(lifecycle.isCurrent(bindingB), false)
  const configForB = lifecycle.beginConfig("b.yaml")!
  lifecycle.beginConfig("")
  assert.equal(configForB.signal.aborted, true)
  assert.equal(lifecycle.snapshotBinding(), null)

  lifecycle.beginConfig("b.yaml")
  lifecycle.closeSession()
  assert.equal(lifecycle.snapshotBinding(), null)
  assert.equal(openSettings.signal.aborted, true)
  assert.equal(openSettings.isCurrent(), false)
})

test("proxy node info settings initialization follows the current node identity", () => {
  const nodes = [
    { provider: "provider-a", name: "node-a", protocol: "ss" },
    { provider: "provider-b", name: "node-b", protocol: "vmess" },
  ]
  const runtime = {
    group: { type: "Selector", all: ["nested"], now: "nested" },
    nested: { type: "Selector", all: ["node-a", "node-b"], now: "node-b" },
    "node-a": { type: "ss" },
    "node-b": { type: "vmess" },
    DIRECT: { type: "Direct" },
  }
  const targetB = proxyNodeInfoTarget(runtime, "group", {
    "node-a": "provider-a", "node-b": "provider-b",
  }, nodes)
  assert.equal(proxyIdentityKey(targetB!), "provider-b\0node-b")
  assert.equal(actualProxyLeafName(runtime, "group"), "node-b")
  assert.equal(actualProxyLeafName({ a: { all: ["b"], now: "b" }, b: { all: ["a"], now: "a" } }, "a"), null)
  assert.equal(proxyNodeInfoTarget(runtime, "DIRECT", {}, nodes), null)
  const duplicate = mergeProxyProviderNodes({}, {
    "provider-first": { proxies: [{ name: "shared", type: "ss" }] },
    "provider-second": { proxies: [{ name: "shared", type: "vmess" }] },
  })
  assert.equal(proxyNodeInfoTarget(
    duplicate.proxies,
    "shared",
    duplicate.providerByNode,
    [{ provider: duplicate.providerByNode.shared!, name: "shared", protocol: "vmess" }],
    duplicate.ambiguousProviderNodes,
  ), null)

  const lifecycle = new ProxyNodeInfoLifecycle()
  let controllerSwitches = 0
  let configWrites = 0
  const generationA = lifecycle.openSession("provider-a\0node-a")
  const settingsA = lifecycle.beginSettings(generationA)!
  let state = { identityKey: "provider-a\0node-a", sessionLoaded: false, loading: true }

  const generationB = lifecycle.openSession(proxyIdentityKey(targetB!))
  const settingsB = lifecycle.beginSettings(generationB)!
  state = { ...state, identityKey: "provider-b\0node-b" }
  const publishedB = publishProxyNodeInfoSettings(lifecycle, settingsA, (identityKey) => identityKey)
  assert.equal(publishedB, null)
  assert.equal(settingsA.finish(), false)
  const currentB = publishProxyNodeInfoSettings(lifecycle, settingsB, (identityKey) => identityKey)
  assert.deepEqual(currentB, {
    identityKey: "provider-b\0node-b",
    selected: "provider-b\0node-b",
  })
  if (currentB) state = { identityKey: currentB.identityKey, sessionLoaded: true, loading: state.loading }
  if (settingsB.finish()) state = { ...state, loading: false }
  assert.deepEqual(state, {
    identityKey: "provider-b\0node-b",
    sessionLoaded: true,
    loading: false,
  })
  assert.equal(controllerSwitches, 0)
  assert.equal(configWrites, 0)

  lifecycle.selectIdentity("provider-b\0node-b")
  const selectedSettings = lifecycle.beginSettings()!
  const publishedSelected = publishProxyNodeInfoSettings(lifecycle, selectedSettings, (identityKey) => identityKey)
  assert.deepEqual(publishedSelected, {
    identityKey: "provider-b\0node-b",
    selected: "provider-b\0node-b",
  })
  selectedSettings.finish()

  const generationOld = lifecycle.openSession("provider-a\0node-a")
  const oldSettings = lifecycle.beginSettings(generationOld)!
  lifecycle.closeSession()
  const generationNew = lifecycle.openSession("provider-b\0node-b")
  const newSettings = lifecycle.beginSettings(generationNew)!
  let reopenedLoading = true
  assert.equal(publishProxyNodeInfoSettings(lifecycle, oldSettings, (identityKey) => identityKey), null)
  if (oldSettings.finish()) reopenedLoading = false
  assert.equal(reopenedLoading, true)
  assert.deepEqual(
    publishProxyNodeInfoSettings(lifecycle, newSettings, (identityKey) => identityKey),
    { identityKey: "provider-b\0node-b", selected: "provider-b\0node-b" },
  )
  assert.equal(newSettings.finish(), true)

  const configB = lifecycle.beginConfig("b.yaml")!
  lifecycle.selectIdentity("provider-c\0node-c")
  assert.equal(configB.signal.aborted, true)
  assert.equal(configB.isCurrent(), false)
  assert.equal(configB.finish(), false)
})

test("proxy node info save guard performs no write for stale bindings", async () => {
  const lifecycle = new ProxyNodeInfoLifecycle()
  const generation = lifecycle.openSession("\0node-a")
  lifecycle.beginSettings(generation)
  const config = lifecycle.beginConfig("a.yaml")!
  const binding = lifecycle.snapshotBinding()
  assert.equal(config.isCurrent(), true)
  let writes = 0
  assert.equal(await saveBoundProxyNodeInfo(lifecycle, binding, async () => {
    writes += 1
    return "saved"
  }), "saved")
  lifecycle.beginConfig("b.yaml")
  assert.equal(await saveBoundProxyNodeInfo(lifecycle, binding, async () => {
    writes += 1
    return "stale"
  }), null)
  assert.equal(writes, 1)
  lifecycle.dispose()
  assert.equal(lifecycle.beginConfig("c.yaml"), null)
})

test("proxy node info lifecycle host survives StrictMode effect replay", async () => {
  const host = new ProxyNodeInfoLifecycleHost()
  const first = host.setup()
  const firstMount = first.lifecycle.beginSettings()!
  const firstGeneration = first.lifecycle.openSession("\0first")
  first.lifecycle.beginSettings(firstGeneration)
  const firstConfig = first.lifecycle.beginConfig("first.yaml")!
  first.cleanup()
  assert.equal(firstMount.signal.aborted, true)
  assert.equal(firstConfig.signal.aborted, true)
  assert.equal(firstConfig.isCurrent(), false)

  const second = host.setup()
  const secondMount = second.lifecycle.beginSettings()!
  const secondGeneration = second.lifecycle.openSession("\0second")
  const secondSettings = second.lifecycle.beginSettings(secondGeneration)!
  const secondConfig = second.lifecycle.beginConfig("second.yaml")!
  const secondBinding = second.lifecycle.snapshotBinding()
  assert.equal(secondMount.signal.aborted, true)
  assert.equal(secondSettings.isCurrent(), true)
  assert.equal(secondConfig.isCurrent(), true)
  let writes = 0
  assert.equal(await saveBoundProxyNodeInfo(second.lifecycle, secondBinding, async () => ++writes), 1)

  first.cleanup()
  assert.equal(host.current(), second.lifecycle)
  assert.equal(secondConfig.isCurrent(), true)
  second.cleanup()
  assert.equal(host.current(), null)
  assert.equal(secondConfig.signal.aborted, true)
  assert.equal(await saveBoundProxyNodeInfo(second.lifecycle, secondBinding, async () => ++writes), null)
  assert.equal(writes, 1)
})

test("runtime rule request sessions survive effect replay and isolate manual refreshes", () => {
  const lifecycle = new RuleRequestLifecycle()
  assert.equal(lifecycle.begin(), null)

  const cleanupFirst = lifecycle.setup()
  const firstSetupRequest = lifecycle.begin()!
  cleanupFirst()
  assert.equal(firstSetupRequest.signal.aborted, true)
  assert.equal(firstSetupRequest.isCurrent(), false)
  assert.equal(firstSetupRequest.finish(), false)

  const cleanupSecond = lifecycle.setup()
  const secondSetupRequest = lifecycle.begin()!
  assert.equal(secondSetupRequest.signal.aborted, false)
  assert.equal(secondSetupRequest.isCurrent(), true)
  assert.equal(secondSetupRequest.finish(), true)

  const firstManualRefresh = lifecycle.begin()!
  const secondManualRefresh = lifecycle.begin()!
  assert.equal(firstManualRefresh.signal.aborted, true)
  assert.equal(firstManualRefresh.isCurrent(), false)
  assert.equal(firstManualRefresh.finish(), false)
  assert.equal(secondManualRefresh.isCurrent(), true)
  assert.equal(secondManualRefresh.finish(), true)

  cleanupSecond()
  assert.equal(lifecycle.begin(), null)
})

test("an older rule request cleanup cannot clear a newer effect session", () => {
  const lifecycle = new RuleRequestLifecycle()
  const cleanupOld = lifecycle.setup()
  const oldRequest = lifecycle.begin()!
  const cleanupCurrent = lifecycle.setup()

  cleanupOld()
  const currentRequest = lifecycle.begin()!
  assert.equal(oldRequest.signal.aborted, true)
  assert.equal(oldRequest.isCurrent(), false)
  assert.equal(currentRequest.isCurrent(), true)

  cleanupCurrent()
  assert.equal(currentRequest.signal.aborted, true)
  assert.equal(lifecycle.begin(), null)
})

test("rule save cancels stale reads without disposing the request session", () => {
  const lifecycle = new RuleRequestLifecycle()
  const cleanup = lifecycle.setup()
  const staleRead = lifecycle.begin()!
  const original = configRuleItems("rules:\n  - DOMAIN,old.example,DIRECT\n  - MATCH,Proxy\n")
  const staleResult = configRuleItems("rules:\n  - DOMAIN,stale.example,DIRECT\n  - MATCH,Proxy\n")
  let editor = createRuleEditorValue(original)

  lifecycle.cancel()
  assert.equal(staleRead.signal.aborted, true)
  assert.equal(staleRead.isCurrent(), false)
  assert.equal(staleRead.finish(), false)
  if (staleRead.isCurrent()) editor = commitRuleEditorRefresh(editor, staleResult).editor
  assert.deepEqual(editor.draft, original)

  assert.equal(lifecycle.begin(true), null)
  const freshRead = lifecycle.begin(false)!
  const freshResult = configRuleItems("rules:\n  - DOMAIN,fresh.example,DIRECT\n  - MATCH,Proxy\n")
  assert.equal(freshRead.isCurrent(), true)
  if (freshRead.isCurrent()) editor = commitRuleEditorRefresh(editor, freshResult).editor
  assert.equal(freshRead.finish(), true)
  assert.deepEqual(editor.draft, freshResult)

  cleanup()
  assert.equal(lifecycle.begin(), null)
})

test("proxy selections commit in user order and roll back to the latest confirmed value", async () => {
  const coordinator = new ProxySelectionCoordinator()
  const firstCommit = deferred()
  const secondCommit = deferred()
  const started: string[] = []
  coordinator.synchronize("AUTO", "A")

  const first = coordinator.enqueue("AUTO", "B", () => {
    started.push("B")
    return firstCommit.promise
  })
  const second = coordinator.enqueue("AUTO", "C", () => {
    started.push("C")
    return secondCommit.promise
  })
  assert.equal(coordinator.pendingSelection("AUTO"), "C")
  assert.deepEqual(coordinator.pendingSelections(), { AUTO: "C" })
  await Promise.resolve()
  assert.deepEqual(started, ["B"])

  firstCommit.resolve()
  const firstOutcome = await first.result
  assert.equal(firstOutcome.success, true)
  assert.equal(firstOutcome.latest, false)
  assert.equal(coordinator.pendingSelection("AUTO"), "C")
  await Promise.resolve()
  assert.deepEqual(started, ["B", "C"])

  secondCommit.reject(new Error("C failed"))
  const outcome = await second.result
  assert.deepEqual(
    { success: outcome.success, latest: outcome.latest, confirmed: outcome.confirmed },
    { success: false, latest: true, confirmed: "B" },
  )
  assert.equal(coordinator.pendingSelection("AUTO"), null)
})

test("two failed proxy selections return to the pre-existing Controller value", async () => {
  const coordinator = new ProxySelectionCoordinator()
  const firstCommit = deferred()
  const secondCommit = deferred()
  coordinator.synchronize("AUTO", "A")

  const first = coordinator.enqueue("AUTO", "B", () => firstCommit.promise)
  const second = coordinator.enqueue("AUTO", "C", () => secondCommit.promise)
  firstCommit.reject(new Error("B failed"))
  await first.result
  await Promise.resolve()
  secondCommit.reject(new Error("C failed"))

  const outcome = await second.result
  assert.equal(outcome.success, false)
  assert.equal(outcome.latest, true)
  assert.equal(outcome.confirmed, "A")
})

test("proxy selection preferences restore the last successful protocol after a newer failure", async () => {
  const coordinator = new ProxySelectionCoordinator()
  const firstCommit = deferred()
  const secondCommit = deferred()
  const preference = "proxy-card-selection:provider:AUTO:card"
  coordinator.synchronize("AUTO", "node-a")

  const first = coordinator.enqueue(
    "AUTO",
    "node-b",
    () => firstCommit.promise,
    { key: preference, current: "node-a" },
  )
  const second = coordinator.enqueue(
    "AUTO",
    "node-c",
    () => secondCommit.promise,
    { key: preference, current: "node-b" },
  )

  firstCommit.resolve()
  const firstOutcome = await first.result
  assert.equal(firstOutcome.confirmedPreference, "node-b")
  secondCommit.reject(new Error("node-c failed"))
  const secondOutcome = await second.result

  assert.equal(secondOutcome.success, false)
  assert.equal(secondOutcome.confirmed, "node-b")
  assert.equal(secondOutcome.confirmedPreference, "node-b")
})

test("proxy request lanes reject stale publication and release all resources on disposal", () => {
  const requests = new ProxyRequestController()
  const actions = new AbortableRequestPool()
  const firstRuntime = requests.beginRuntime()
  const addresses = requests.beginAddresses()
  const firstOrder = requests.beginGroupOrder()
  const order = requests.beginGroupOrder()
  assert.equal(firstOrder.isCurrent(), false)
  assert.equal(firstOrder.signal.aborted, true)
  const action = actions.begin()
  const secondRuntime = requests.beginRuntime()

  assert.equal(firstRuntime.signal.aborted, true)
  assert.equal(firstRuntime.isCurrent(), false)
  assert.equal(addresses.signal.aborted, false)
  assert.equal(order.signal.aborted, false)
  assert.equal(action.signal.aborted, false)
  assert.equal(secondRuntime.isCurrent(), true)

  requests.dispose()
  actions.dispose()
  assert.equal(secondRuntime.signal.aborted, true)
  assert.equal(addresses.signal.aborted, true)
  assert.equal(order.signal.aborted, true)
  assert.equal(action.signal.aborted, true)
  assert.equal(secondRuntime.isCurrent(), false)

  const afterDispose = requests.beginRuntime()
  const actionAfterDispose = actions.begin()
  assert.equal(afterDispose.signal.aborted, true)
  assert.equal(afterDispose.isCurrent(), false)
  assert.equal(actionAfterDispose.signal.aborted, true)
})

test("a successful subscription write commits its server id before any list refresh", () => {
  const saved = {
    id: "saved-id",
    name: "Production",
    providerName: "production",
    extractProvider: true,
    mergeIntoConfig: false,
    configName: "",
    binding: null,
    autoUpdate: true,
    intervalMinutes: 60,
    lastUpdatedAt: null,
    status: "idle",
    urlConfigured: true,
  }
  const committed = upsertSubscriptionSnapshot([], saved)

  assert.equal(committed[0]?.id, "saved-id")
  assert.deepEqual(removeSubscriptionSnapshot(committed, "saved-id"), [])
})
