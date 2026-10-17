// 编排订阅 Provider 落盘与 Controller 重载，并保留两阶段失败语义。
import {
  activateSubscriptionBinding,
  beginSubscriptionBinding,
  beginSubscriptionBindingRemoval,
  readConfigFile,
  releaseSubscriptionBinding,
  saveConfigFile,
  deleteSubscription,
  listSubscriptions,
  updateSubscription,
  updateSubscriptionProvider,
  type ConfigSnapshot,
  type ConfigSubscription,
  type ConfigSubscriptionInput,
} from "../../api/configClient.ts";
import { reloadProxyProvider } from "../../api/controllerClient.ts";
import { readSubscriptionRuntimeTargets, type SubscriptionRefreshStatus } from "./subscriptionRuntime.ts";
import {
  addSubscriptionBinding,
  assertSubscriptionBindingAvailable,
  ensurePendingSubscriptionBinding,
  removeSubscriptionBinding,
} from "./subscriptionConfigBinding.ts";

export class ProviderReloadError extends Error {
  readonly result: Awaited<ReturnType<typeof updateSubscriptionProvider>>;

  constructor(result: Awaited<ReturnType<typeof updateSubscriptionProvider>>, options?: ErrorOptions) {
    super("Subscription updated but runtime proxy provider refresh failed", options);
    this.result = result;
  }
}

export class SubscriptionBindingTransactionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

export class InitialProviderGenerationError extends Error {
  constructor(options?: ErrorOptions) {
    super("Provider 首次生成失败；尚未写入配置绑定", options)
  }
}

export async function applySubscriptionConfigBinding(
  subscription: ConfigSubscription,
  provider: Awaited<ReturnType<typeof updateSubscriptionProvider>> | null,
  syncSnapshot: (snapshot: ConfigSnapshot) => void,
  dependencies = {
    read: readConfigFile,
    save: saveConfigFile,
    begin: beginSubscriptionBinding,
    activate: activateSubscriptionBinding,
    release: releaseSubscriptionBinding,
  },
) {
  if (!subscription.mergeIntoConfig || !subscription.configName)
    return subscription
  if (!subscription.providerSha256 && !provider?.providerSha256) {
    throw new SubscriptionBindingTransactionError("订阅尚未生成 Provider，无法合并进配置")
  }
  if (subscription.binding?.status === "active") return subscription
  if (subscription.binding?.status === "pending-remove") {
    throw new SubscriptionBindingTransactionError("绑定正在移除，请先重试保存或删除操作")
  }
  let pending = subscription
  const claimedHere = !subscription.binding
  if (claimedHere) pending = await dependencies.begin(subscription.id)
  const binding = pending.binding
  let snapshot: ConfigSnapshot
  let content: string
  try {
    if (!binding) throw new SubscriptionBindingTransactionError("订阅尚未生成 Provider，无法合并进配置")
    snapshot = await dependencies.read(binding.configName)
    if (claimedHere) assertSubscriptionBindingAvailable(snapshot.content, binding)
    if (binding.status !== "pending-add") {
      throw new SubscriptionBindingTransactionError("绑定认领状态异常，未修改配置")
    }
    content = claimedHere
      ? addSubscriptionBinding(snapshot.content, binding)
      : ensurePendingSubscriptionBinding(snapshot.content, binding)
  } catch (error) {
    if (claimedHere) {
      try {
        await dependencies.release(subscription.id)
      } catch (releaseError) {
        throw new SubscriptionBindingTransactionError(
          "绑定准备失败且认领撤销失败，已保留可重试状态",
          { cause: releaseError }
        )
      }
    }
    throw error
  }
  if (content !== snapshot.content) {
    try {
      const saved = await dependencies.save(
        binding.configName,
        content,
        snapshot.sha256
      )
      syncSnapshot(saved)
    } catch (error) {
      try {
        await dependencies.release(subscription.id)
      } catch (releaseError) {
        throw new SubscriptionBindingTransactionError(
          "配置保存失败且认领撤销失败，已保留可重试状态",
          { cause: releaseError }
        )
      }
      throw error
    }
  }
  try {
    return await dependencies.activate(subscription.id)
  } catch (error) {
    throw new SubscriptionBindingTransactionError(
      "配置已保存，绑定激活未完成；再次更新订阅可继续",
      { cause: error }
    )
  }
}

export async function generateInitialProviderAndApplyBinding(
  subscription: ConfigSubscription,
  syncSnapshot: (snapshot: ConfigSnapshot) => void,
  dependencies = {
    update: updateSubscriptionProvider,
    list: listSubscriptions,
    apply: applySubscriptionConfigBinding,
  },
) {
  let provider: Awaited<ReturnType<typeof updateSubscriptionProvider>>
  try {
    provider = await dependencies.update(subscription.id)
  } catch (error) {
    throw new InitialProviderGenerationError({ cause: error })
  }
  if (!provider.providerSha256) {
    throw new InitialProviderGenerationError()
  }
  if (provider.config) syncSnapshot(provider.config)

  let refreshError: unknown = null
  let refreshed: ConfigSubscription | undefined
  try {
    refreshed = (await dependencies.list()).find((item) => item.id === subscription.id)
  } catch (error) {
    refreshError = error
  }
  let committed: ConfigSubscription = {
    ...(refreshed ?? subscription),
    providerSha256: provider.providerSha256,
  }
  if (committed.mergeIntoConfig && !committed.binding) {
    committed = await dependencies.apply(committed, provider, syncSnapshot)
  }
  return { subscription: committed, refreshError }
}

export async function prepareSubscriptionConfigBindingRemoval(
  subscription: ConfigSubscription,
  syncSnapshot: (snapshot: ConfigSnapshot) => void,
  dependencies = {
    read: readConfigFile,
    save: saveConfigFile,
    beginRemoval: beginSubscriptionBindingRemoval,
  },
) {
  if (!subscription.binding) return subscription
  const removing = subscription.binding.status === "pending-remove"
    ? subscription
    : await dependencies.beginRemoval(subscription.id)
  const binding = removing.binding
  if (!binding || binding.status !== "pending-remove") {
    throw new SubscriptionBindingTransactionError("绑定移除状态异常，未修改配置")
  }
  const snapshot = await dependencies.read(binding.configName)
  const content = removeSubscriptionBinding(snapshot.content, binding)
  if (content !== snapshot.content) {
    const saved = await dependencies.save(
      binding.configName,
      content,
      snapshot.sha256
    )
    syncSnapshot(saved)
  }
  return removing
}

export async function clearSubscriptionConfigBinding(
  subscription: ConfigSubscription,
  syncSnapshot: (snapshot: ConfigSnapshot) => void,
  dependencies = {
    read: readConfigFile,
    save: saveConfigFile,
    beginRemoval: beginSubscriptionBindingRemoval,
    release: releaseSubscriptionBinding,
  },
) {
  const removing = await prepareSubscriptionConfigBindingRemoval(
    subscription,
    syncSnapshot,
    dependencies
  )
  if (!removing.binding) return removing
  try {
    return await dependencies.release(subscription.id)
  } catch (error) {
    throw new SubscriptionBindingTransactionError(
      "配置清理已完成，绑定释放未完成；再次操作可继续",
      { cause: error }
    )
  }
}

function inputFromSubscription(subscription: ConfigSubscription): ConfigSubscriptionInput {
  return {
    name: subscription.name,
    url: subscription.url,
    extractProvider: subscription.extractProvider,
    providerName: subscription.providerName,
    providerNameMode: subscription.providerNameMode,
    mergeIntoConfig: subscription.mergeIntoConfig,
    configName: subscription.configName,
    groupNames: subscription.groupNames,
    autoUpdate: subscription.autoUpdate,
    intervalMinutes: subscription.intervalMinutes,
  }
}

export async function migrateSubscriptionBinding(
  subscription: ConfigSubscription,
  input: ConfigSubscriptionInput,
  syncSnapshot: (snapshot: ConfigSnapshot) => void,
  dependencies = {
    list: listSubscriptions,
    read: readConfigFile,
    save: saveConfigFile,
    update: updateSubscription,
    beginRemoval: beginSubscriptionBindingRemoval,
    release: releaseSubscriptionBinding,
    begin: beginSubscriptionBinding,
    activate: activateSubscriptionBinding,
  },
) {
  if (!subscription.binding) return dependencies.update(subscription.id, input)
  const configNames = [...new Set([
    subscription.binding.configName,
    input.mergeIntoConfig ? input.configName ?? "" : "",
  ].filter(Boolean))]
  await Promise.all(configNames.map((name) => dependencies.read(name)))
  const journal: Array<{
    before: ConfigSnapshot
    intendedContent: string
    afterSha256: string | null
  }> = []
  const saveForward = async (before: ConfigSnapshot, content: string) => {
    const intent = { before, intendedContent: content, afterSha256: null as string | null }
    journal.push(intent)
    const saved = await dependencies.save(before.name, content, before.sha256)
    intent.afterSha256 = saved.sha256
    syncSnapshot(saved)
    return saved
  }
  const oldBinding = subscription.binding
  try {
    await dependencies.beginRemoval(subscription.id)
    let updated = await dependencies.update(subscription.id, input)
    if (updated.mergeIntoConfig && updated.providerSha256) {
      const pending = await dependencies.begin(updated.id)
      const newBinding = pending.binding
      if (!newBinding || newBinding.status !== "pending-add") {
        throw new SubscriptionBindingTransactionError("新绑定认领状态异常")
      }
      if (newBinding.configName === oldBinding.configName) {
        const fresh = await dependencies.read(newBinding.configName)
        const withoutOld = removeSubscriptionBinding(fresh.content, oldBinding)
        assertSubscriptionBindingAvailable(withoutOld, newBinding)
        const content = addSubscriptionBinding(withoutOld, newBinding)
        if (content !== fresh.content) {
          await saveForward(fresh, content)
        }
        updated = await dependencies.activate(updated.id)
      } else {
        const target = await dependencies.read(newBinding.configName)
        assertSubscriptionBindingAvailable(target.content, newBinding)
        const targetContent = addSubscriptionBinding(target.content, newBinding)
        await saveForward(target, targetContent)
        updated = await dependencies.activate(updated.id)
        const old = await dependencies.read(oldBinding.configName)
        const oldContent = removeSubscriptionBinding(old.content, oldBinding)
        if (oldContent !== old.content) {
          await saveForward(old, oldContent)
        }
      }
    } else {
      const old = await dependencies.read(oldBinding.configName)
      const content = removeSubscriptionBinding(old.content, oldBinding)
      if (content !== old.content) {
        await saveForward(old, content)
      }
    }
    return updated
  } catch (error) {
    const rollbackErrors: unknown[] = []
    let current: ConfigSubscription | undefined
    try {
      current = (await dependencies.list()).find((item) => item.id === subscription.id)
      if (!current) throw new SubscriptionBindingTransactionError("订阅迁移后状态不可用")
    } catch (rollbackError) { rollbackErrors.push(rollbackError) }
    if (current?.binding) {
      if (current.binding.status !== "pending-remove") {
        try { current = await dependencies.beginRemoval(current.id) }
        catch (rollbackError) { rollbackErrors.push(rollbackError) }
      }
      try { current = await dependencies.release(subscription.id) }
      catch (rollbackError) { rollbackErrors.push(rollbackError) }
    }
    try {
      await dependencies.update(subscription.id, inputFromSubscription(subscription))
    } catch (rollbackError) { rollbackErrors.push(rollbackError) }

    let configRollbackFailed = false
    for (const entry of [...journal].reverse()) {
      try {
        const currentSnapshot = await dependencies.read(entry.before.name)
        if (
          currentSnapshot.sha256 === entry.before.sha256 &&
          currentSnapshot.content === entry.before.content
        ) continue
        const expectedSha256 = entry.afterSha256
          ? currentSnapshot.sha256 === entry.afterSha256 ? entry.afterSha256 : null
          : currentSnapshot.content === entry.intendedContent ? currentSnapshot.sha256 : null
        if (!expectedSha256) {
          throw new SubscriptionBindingTransactionError("配置在迁移补偿前已变化")
        }
        const restored = await dependencies.save(
          entry.before.name,
          entry.before.content,
          expectedSha256,
        )
        syncSnapshot(restored)
      } catch (rollbackError) {
        configRollbackFailed = true
        rollbackErrors.push(rollbackError)
      }
    }

    try {
      const restored = (await dependencies.list()).find((item) => item.id === subscription.id)
      if (
        !restored ||
        restored.providerName !== subscription.providerName ||
        restored.configName !== subscription.configName ||
        JSON.stringify(restored.groupNames) !== JSON.stringify(subscription.groupNames)
      ) throw new SubscriptionBindingTransactionError("旧订阅元数据恢复失败")
      const pending = await dependencies.begin(subscription.id)
      const restoredBinding = pending.binding
      if (!restoredBinding) throw new SubscriptionBindingTransactionError("旧绑定认领恢复失败")
      const oldSnapshot = await dependencies.read(restoredBinding.configName)
      const ensured = ensurePendingSubscriptionBinding(oldSnapshot.content, restoredBinding)
      if (ensured !== oldSnapshot.content) {
        if (configRollbackFailed) throw new SubscriptionBindingTransactionError("旧配置无法安全恢复")
        const saved = await dependencies.save(oldSnapshot.name, ensured, oldSnapshot.sha256)
        syncSnapshot(saved)
      }
      await dependencies.activate(pending.id)
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError)
    }
    if (rollbackErrors.length) {
      throw new SubscriptionBindingTransactionError(
        "订阅迁移失败且旧绑定恢复未完成，请重新读取后重试",
        { cause: new AggregateError([error, ...rollbackErrors]) },
      )
    }
    throw new SubscriptionBindingTransactionError(
      "订阅迁移失败，旧名称和绑定已恢复",
      { cause: error },
    )
  }
}

export function updateSubscriptionAfterBindingRemoval(
  subscription: ConfigSubscription,
  input: ConfigSubscriptionInput,
  syncSnapshot: (snapshot: ConfigSnapshot) => void,
) {
  return migrateSubscriptionBinding(subscription, input, syncSnapshot)
}

export async function deleteSubscriptionAfterBindingRemoval(
  subscription: ConfigSubscription,
  syncSnapshot: (snapshot: ConfigSnapshot) => void,
  onPrepared: (subscription: ConfigSubscription) => void = () => undefined,
  dependencies = {
    prepare: prepareSubscriptionConfigBindingRemoval,
    delete: deleteSubscription,
  },
) {
  const removing = await dependencies.prepare(subscription, syncSnapshot)
  onPrepared(removing)
  await dependencies.delete(subscription.id)
}

export async function updateSubscriptionAndReloadProvider(
  id: string,
  dependencies = {
    update: updateSubscriptionProvider,
    reload: reloadProxyProvider,
    targets: readSubscriptionRuntimeTargets,
  },
  afterUpdate?: (
    result: Awaited<ReturnType<typeof updateSubscriptionProvider>>
  ) => Promise<void>,
) {
  const result = await dependencies.update(id);
  await afterUpdate?.(result)
  const completed = (runtimeRefresh: SubscriptionRefreshStatus) => ({ ...result, runtimeRefresh })
  if (!result.providerPath) return completed("not-required")
  const target = await dependencies.targets(id, result)
  if (target.status !== "matched") return completed(target.status)
  try {
    for (const name of target.names) await dependencies.reload(name);
  } catch (cause) {
    throw new ProviderReloadError(result, { cause });
  }
  return completed("refreshed");
}
