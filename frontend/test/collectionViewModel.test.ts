import assert from "node:assert/strict"
import test from "node:test"
import { managedProviderRuntimePaired, managementLifecycleState, reduceManagementLifecycle } from "../src/features/providers/managedProviderState.ts"
import { cleanupReason } from "../src/shared/collectionCleanup.ts"
import { retainedProviderMessage } from "../src/shared/configMessages.ts"
import type { ProviderRuntimeReferences } from "../src/api/configClient.ts"

import {
  providerDisplayName,
  providerItemCount,
  providerMemberDocument,
  providerMetadataDocument,
  providerSource,
  visibleProviderMap,
} from "../src/features/providers/collectionViewModel.ts"

test("an editing draft stays with source A when the confirmed runtime source changes to B", () => {
  const baseline = { snapshot: { name: "A.yaml", path: "/fixture/A.yaml", sha256: "source-a", content: "mode: direct\n" }, files: [], httpOwners: [], controls: {} }
  const nextBaseline = { ...baseline, snapshot: { ...baseline.snapshot, name: "B.yaml", sha256: "source-b" } }
  let state = managementLifecycleState(baseline)
  state = reduceManagementLifecycle(state, { type: "start", requestKey: "management:B.yaml:source-b" })
  state = reduceManagementLifecycle(state, { type: "success", requestKey: "management:B.yaml:source-b", loadedKey: "management:B.yaml:source-b",
    baselineKey: "management:B.yaml:source-b", baseline: nextBaseline, dirty: true, resourcesChanged: false })
  assert.equal(state.baseline?.snapshot.name, "A.yaml")
  assert.equal(state.status, "stale")
  assert.equal(managedProviderRuntimePaired(state.baseline!.snapshot, "B.yaml", state.status), false)
  assert.equal(managedProviderRuntimePaired(baseline.snapshot, "B.yaml", "ready"), false)
  assert.equal(managedProviderRuntimePaired(baseline.snapshot, null, "ready"), false)
  for (const status of ["loading", "stale", "unavailable", "error"] as const) {
    assert.equal(managedProviderRuntimePaired(baseline.snapshot, "A.yaml", status), false)
  }
  assert.equal(managedProviderRuntimePaired(baseline.snapshot, "A.yaml", "ready"), true)
})

test("cleanup reasons distinguish a path reference, a linked file and an unreadable configuration", () => {
  const item = { category: "proxy" as const, fileName: "fixture.yaml", sha256: "fixture-sha", identity: "fixture-id",
    action: "keep" as const, reason: "referenced" as const, configNames: ["A.yaml", "B.yaml", "C.yaml"] }
  assert.equal(cleanupReason({ ...item, configReferences: [
    { configName: "A.yaml", kind: "path" }, { configName: "B.yaml", kind: "identity" }, { configName: "C.yaml", kind: "unreadable" },
  ] }), "配置仍在引用此路径：A.yaml；配置中的其他路径关联同一文件：B.yaml；配置引用无法确认（读取、解析或引用检查失败）：C.yaml")
  assert.equal(cleanupReason({ ...item, configReferences: [{ configName: "C.yaml", kind: "unreadable" }] }), "配置引用无法确认（读取、解析或引用检查失败）：C.yaml")
  assert.equal(cleanupReason({ ...item, configReferences: [{ configName: "B.yaml", kind: "identity" }] }), "配置中的其他路径关联同一文件：B.yaml")
})

test("rename cleanup explains the referenced names, current uncertainty and explicit next step", () => {
  const evidence = {
    configReferences: [{ configName: "main.yaml", kind: "identity" as const, path: "./providers/new.yaml" }],
    runtime: { references: [{ kind: "identity" as const, path: "./providers/new.yaml" }], uncertain: true, unknownReason: "core_unverified" as const,
      hasSuccessfulRecord: true, scanComplete: true },
  }
  const text = cleanupReason({ category: "proxy", fileName: "old.yaml", sha256: "fixture", identity: "fixture", action: "keep", reason: "runtime_unknown", ...evidence })
  assert.match(text, /main.yaml → .\/providers\/new.yaml/)
  assert.match(text, /最近成功加载的运行文件通过其他路径关联同一文件/)
  assert.match(text, /最近成功加载的运行文件未引用此路径/)
  assert.match(text, /运行依赖未知：成功加载记录不能持续确认 Core 当前完整依赖/)
  assert.doesNotMatch(text, /配置仍在引用此路径/)
  assert.match(retainedProviderMessage({ fileName: "old.yaml", reason: "runtime_unknown", ...evidence }), /成功应用后.*清理集合文件.*勾选旧文件/)
  const failed = cleanupReason({ category: "proxy", fileName: "old.yaml", sha256: "fixture", identity: "fixture", action: "keep", reason: "runtime_reference",
    runtime: { references: [{ kind: "path", path: "./providers/old.yaml" }], uncertain: true, unknownReason: "load_failed" } })
  assert.match(failed, /最近成功加载的运行文件引用此路径：.\/providers\/old.yaml/)
  assert.match(failed, /上次应用失败/)
})

test("cleanup negative runtime evidence requires an explicit successful record and complete scan", () => {
  const message = (runtime: ProviderRuntimeReferences) => cleanupReason({ category: "proxy", fileName: "old.yaml", sha256: "fixture",
    identity: "fixture", action: "keep", reason: "runtime_unknown", runtime })
  for (const unknownReason of ["load_pending", "load_unknown", "load_failed"] as const) {
    const runtime = { references: [], uncertain: true, unknownReason }
    const missing = message({ ...runtime, hasSuccessfulRecord: false, scanComplete: false })
    assert.match(missing, /尚无成功加载记录/)
    assert.doesNotMatch(missing, /未引用此路径/)
    assert.doesNotMatch(message(runtime), /未引用此路径/)
    assert.doesNotMatch(message({ ...runtime, hasSuccessfulRecord: true }), /未引用此路径/)
    assert.doesNotMatch(message({ ...runtime, scanComplete: true }), /未引用此路径/)
    assert.match(message({ ...runtime, hasSuccessfulRecord: true, scanComplete: true }), /未引用此路径/)
    const partial = { ...runtime, hasSuccessfulRecord: true, scanComplete: false }
    assert.match(message(partial), /引用检查不完整/)
    assert.doesNotMatch(message(partial), /未引用此路径/)
    const positive = message({ ...partial, references: [{ kind: "path", path: "./providers/old.yaml" }] })
    assert.match(positive, /最近成功加载的运行文件引用此路径：/)
    assert.match(positive, /引用检查不完整/)
    assert.doesNotMatch(positive, /未引用此路径/)
  }
})

test("provider view model maps native Controller fields without inventing members", () => {
  const proxy = {
    vehicleType: "HTTP",
    proxies: [{ name: "node-a", type: "Vless" }, { name: "node-b", type: "Direct" }],
  }
  assert.equal(providerSource(proxy), "HTTP")
  assert.equal(providerItemCount("proxy", proxy), 2)
  assert.equal(providerItemCount("proxy", { proxyCount: 7 }), 7)
  assert.equal(providerItemCount("rule", { rules: ["MATCH,DIRECT"] }), 1)
  assert.equal(providerItemCount("rule", { payload: ["example.test", "example.org"] }), 2)
  assert.equal(providerItemCount("rule", { ruleCount: 5135 }), 5135)

  const unavailableRules = providerMemberDocument("rule", { ruleCount: 5135 })
  assert.match(unavailableRules, /Controller 未在 Provider 响应中返回规则明细/)
  assert.match(unavailableRules, /ruleCount: 5135/)
  assert.doesNotMatch(unavailableRules, /DOMAIN-SUFFIX|RULE-SET/)
})

test("provider editor documents recursively redact credentials and complete URLs", () => {
  const metadata = providerMetadataDocument("private-provider", {
    vehicleType: "HTTP",
    url: "https://subscription.invalid/config?token=fixture-token",
    nested: {
      token: "fixture-token",
      authorization: "fixture-authorization",
      values: [
        { password: "fixture-password" },
        "mirror: https://mirror.invalid/provider.yaml",
      ],
    },
    homepage: "https://homepage.invalid/private",
    proxies: [{ name: "node-a" }],
  })

  assert.match(metadata, /private-provider/)
  assert.match(metadata, /\[redacted\]/)
  for (const protectedValue of [
    "fixture-token",
    "fixture-authorization",
    "fixture-password",
    "subscription.invalid",
    "mirror.invalid",
    "homepage.invalid",
  ]) {
    assert.equal(
      metadata.includes(protectedValue),
      false,
      "metadata contains a protected fixture value"
    )
  }
  assert.doesNotMatch(metadata, /node-a/)

  assert.equal(
    providerDisplayName("https://display.invalid/provider?token=fixture").includes("display.invalid"),
    false,
    "display name contains a protected fixture value"
  )
  assert.equal(
    providerSource({ vehicleType: "https://source.invalid/provider" }).includes("source.invalid"),
    false,
    "provider source contains a protected fixture value"
  )
})

test("provider member documents contain only real returned members", () => {
  const proxyMembers = providerMemberDocument("proxy", {
    proxies: [
      {
        name: "node-a",
        server: "192.0.2.10",
        nested: {
          secret: "fixture-member-secret",
          endpoint: "https://member.invalid/path",
        },
      },
    ],
  })
  const ruleMembers = providerMemberDocument("rule", {
    rules: ["DOMAIN-SUFFIX,example.test,DIRECT"],
  })

  assert.match(proxyMembers, /node-a/)
  assert.match(proxyMembers, /192\.0\.2\.10/)
  assert.match(ruleMembers, /DOMAIN-SUFFIX,example\.test,DIRECT/)
  assert.equal(
    proxyMembers.includes("fixture-member-secret") || proxyMembers.includes("member.invalid"),
    false,
    "member document contains a protected fixture value"
  )
  assert.doesNotMatch(proxyMembers, /^\s*\{/)
})

test("proxy collections hide built-in and Compatible views while retaining real provider types", () => {
  const providers = {
    default: { vehicleType: "Compatible" },
    "automatic-group": { vehicleType: "Compatible" },
    "another-group": { vehicleType: "compatible" },
    "default-extra": { vehicleType: "HTTP" },
    subscription: { vehicleType: "File" },
    inline: { vehicleType: "Inline" },
  }
  assert.deepEqual(Object.keys(visibleProviderMap("proxy", providers)), [
    "default-extra",
    "subscription",
    "inline",
  ])
  assert.deepEqual(Object.keys(visibleProviderMap("rule", providers)), [
    "default",
    "automatic-group",
    "another-group",
    "default-extra",
    "subscription",
    "inline",
  ])
  assert.deepEqual(visibleProviderMap("proxy", {
    default: providers.default,
    arbitrary: providers["automatic-group"],
  }), {})
  assert.equal(visibleProviderMap("proxy", providers).subscription, providers.subscription)
  assert.equal(visibleProviderMap("rule", providers), providers)
})
