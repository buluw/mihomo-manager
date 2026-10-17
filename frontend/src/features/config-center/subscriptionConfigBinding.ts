import { isMap, isScalar, isSeq, parseDocument } from "yaml"

import type { ConfigSubscriptionBinding } from "@/api/configClient"

export class SubscriptionBindingError extends Error {}

function expectedProvider(binding: ConfigSubscriptionBinding) {
  return { type: "file", path: binding.providerPath }
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function documentFor(content: string) {
  const document = parseDocument(content)
  if (document.errors.length > 0)
    throw new SubscriptionBindingError("目标配置不是有效的 YAML")
  return document
}

export function addSubscriptionBinding(
  content: string,
  binding: ConfigSubscriptionBinding
) {
  const document = documentFor(content)
  let providers = document.get("proxy-providers", true)
  if (providers == null) {
    document.set("proxy-providers", document.createNode({}))
    providers = document.get("proxy-providers", true)
  }
  if (!isMap(providers))
    throw new SubscriptionBindingError("目标配置的 proxy-providers 不是映射")
  if (providers.has(binding.providerName))
    throw new SubscriptionBindingError("目标配置已存在同名 Provider，未执行合并")

  providers.set(binding.providerName, expectedProvider(binding))
  addGroupReferences(document, binding, false)
  return document.toString({ lineWidth: 0 })
}

function selectedGroups(document: ReturnType<typeof documentFor>, binding: ConfigSubscriptionBinding) {
  const groups = document.get("proxy-groups", true)
  if (!isSeq(groups)) throw new SubscriptionBindingError("目标配置的 proxy-groups 不是列表")
  const names = binding.groupNames?.length ? binding.groupNames : [binding.providerName]
  return names.map((name) => {
    const group = groups.items.find((item) => isMap(item) && item.get("name") === name)
    if (!isMap(group)) throw new SubscriptionBindingError(`目标代理组 ${name} 已失效`)
    if (group.get("include-all-providers") === true || group.get("include-all") === true) {
      throw new SubscriptionBindingError(`目标代理组 ${name} 已自动包含全部 Provider`)
    }
    return group
  })
}

function addGroupReferences(
  document: ReturnType<typeof documentFor>,
  binding: ConfigSubscriptionBinding,
  allowExisting: boolean,
) {
  let changed = false
  selectedGroups(document, binding).forEach((group) => {
    let use = group.get("use", true)
    if (use == null) {
      group.set("use", document.createNode([]))
      use = group.get("use", true)
    }
    if (!isSeq(use)) throw new SubscriptionBindingError("目标代理组的 use 不是列表")
    const exists = use.items.some((item) => isScalar(item) && item.value === binding.providerName)
    if (exists && !allowExisting) throw new SubscriptionBindingError("目标代理组已包含同名 Provider，无法确认引用归属")
    if (!exists) {
      use.add(binding.providerName)
      changed = true
    }
  })
  return changed
}

export function subscriptionBindableGroups(
  content: string,
  providerName: string,
  ownedGroupNames: readonly string[] = [],
) {
  const document = documentFor(content)
  const groups = document.get("proxy-groups", true)
  if (groups == null) return []
  if (!isSeq(groups)) throw new SubscriptionBindingError("目标配置的 proxy-groups 不是列表")
  return groups.items.flatMap((item) => {
    if (!isMap(item) || typeof item.get("name") !== "string") return []
    if (item.get("include-all-providers") === true || item.get("include-all") === true) return []
    const use = item.get("use", true)
    if (use != null && !isSeq(use)) return []
    if (
      isSeq(use) &&
      use.items.some((entry) => isScalar(entry) && entry.value === providerName) &&
      !ownedGroupNames.includes(String(item.get("name")))
    ) return []
    return [String(item.get("name"))]
  })
}

export function assertSubscriptionBindingAvailable(
  content: string,
  binding: ConfigSubscriptionBinding
) {
  const document = documentFor(content)
  const providers = document.get("proxy-providers", true)
  if (providers != null && !isMap(providers))
    throw new SubscriptionBindingError("目标配置的 proxy-providers 不是映射")
  if (isMap(providers) && providers.has(binding.providerName))
    throw new SubscriptionBindingError("目标配置已存在同名 Provider，未执行合并")
  selectedGroups(document, binding)
}

export function ensurePendingSubscriptionBinding(
  content: string,
  binding: ConfigSubscriptionBinding
) {
  const document = documentFor(content)
  let providers = document.get("proxy-providers", true)
  if (providers == null) {
    document.set("proxy-providers", document.createNode({}))
    providers = document.get("proxy-providers", true)
  }
  if (!isMap(providers))
    throw new SubscriptionBindingError("目标配置的 proxy-providers 不是映射")
  const provider = providers.get(binding.providerName)
  if (provider != null && !sameValue(provider, expectedProvider(binding)))
    throw new SubscriptionBindingError("待完成的 Provider 声明已被其他内容占用")

  let changed = false
  if (provider == null) {
    providers.set(binding.providerName, expectedProvider(binding))
    changed = true
  }
  changed = addGroupReferences(document, binding, true) || changed
  return changed ? document.toString({ lineWidth: 0 }) : content
}

export function removeSubscriptionBinding(
  content: string,
  binding: ConfigSubscriptionBinding
) {
  const document = documentFor(content)
  const providers = document.get("proxy-providers", true)
  if (providers != null && !isMap(providers))
    throw new SubscriptionBindingError("目标配置的 proxy-providers 不是映射")
  const provider = isMap(providers)
    ? providers.get(binding.providerName)
    : undefined
  if (provider != null && !sameValue(provider, expectedProvider(binding)))
    throw new SubscriptionBindingError("已认领的 Provider 声明已被修改，未自动删除")

  let changed = false
  if (provider != null && isMap(providers)) {
    providers.delete(binding.providerName)
    changed = true
  }
  const groups = document.get("proxy-groups", true)
  if (groups != null && !isSeq(groups)) {
    throw new SubscriptionBindingError("目标配置的 proxy-groups 不是列表")
  }
  const names = binding.groupNames?.length ? binding.groupNames : [binding.providerName]
  names.forEach((name) => {
    const group = isSeq(groups)
      ? groups.items.find((item) => isMap(item) && item.get("name") === name)
      : undefined
    if (!isMap(group)) return
    const use = group.get("use", true)
    if (use == null) return
    if (!isSeq(use)) throw new SubscriptionBindingError("已认领代理组的 use 已被修改")
    const remaining = use.items.filter((item) => !isScalar(item) || item.value !== binding.providerName)
    if (remaining.length !== use.items.length) {
      use.items = remaining
      changed = true
    }
  })
  return changed ? document.toString({ lineWidth: 0 }) : content
}
