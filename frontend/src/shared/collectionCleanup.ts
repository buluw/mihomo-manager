import type { ManagedProviderFile, ProviderCleanupItem, ProviderConfigReference, ProviderRuntimeReferences } from "../api/configClient.ts"

type CleanupOutcome = Pick<ProviderCleanupItem, "fileName" | "action" | "reason"> & Partial<ProviderCleanupItem>

export function cleanupPresentation(item: ProviderCleanupItem, file?: ManagedProviderFile) {
  const metadata = file?.category === item.category && file.fileName === item.fileName && file.sha256 === item.sha256 ? file : undefined
  const configNames = [...new Set(item.configReferences ? item.configReferences.filter(ref => ref.kind !== "unreadable").map(ref => ref.configName) : item.configNames ?? [])]
  const configUnknown = item.configReferences?.some(ref => ref.kind === "unreadable") ?? false
  const recordedReference = Boolean(item.runtime?.references.length || item.reason === "runtime_reference")
  const recordLabel = recordedReference ? "有引用" : item.runtime?.hasSuccessfulRecord === false ? "无成功记录"
    : item.runtime?.hasSuccessfulRecord === true && item.runtime.scanComplete === true ? "未发现引用" : "记录无法确认"
  const maintained = metadata?.source === "local" || metadata?.source === "subscription" || item.reason === "maintained"
  const sources = { manual: "受管文件", external: "外部文件", subscription: "订阅提取", local: "配置提取" }
  return {
    configNames, configUnknown, recordedReference, recordLabel, maintained,
    runtimeUnknown: item.runtime?.uncertain !== false,
    source: metadata ? sources[metadata.source] : maintained ? "自动提取维护" : "来源无法确认",
    path: metadata?.referencePath ?? item.fileName,
  }
}

export function cleanupSelectionHint(files: ProviderCleanupItem[], catalog: ManagedProviderFile[] = []) {
  if (!files.length) return "选择文件后清理，可展开详情核对引用和来源。"
  const views = files.map(item => cleanupPresentation(item, catalog.find(file => file.category === item.category && file.fileName === item.fileName)))
  const referenced = views.filter(item => item.configNames.length || item.recordedReference).length
  const unknown = views.filter(item => item.runtimeUnknown || item.configUnknown).length
  const maintained = views.filter(item => item.maintained).length
  return [referenced ? referenced + " 个仍有引用，删除会导致文件缺失" : "未发现已记录引用，仍需确认当前运行依赖",
    unknown ? unknown + " 个依赖无法确认" : "", maintained ? maintained + " 个自动维护文件可能再次生成" : ""].filter(Boolean).join("；")
}

export function providerReferenceMessage(configReferences?: ProviderConfigReference[], runtime?: ProviderRuntimeReferences) {
  const messages: string[] = []
  if (configReferences?.length) {
    const labels = { path: "配置仍在引用此路径", identity: "配置中的其他路径关联同一文件", unreadable: "配置引用无法确认（读取、解析或引用检查失败）" }
    messages.push(...(Object.keys(labels) as Array<keyof typeof labels>).flatMap((kind) => {
      const names = [...new Set(configReferences.filter((entry) => entry.kind === kind).map((entry) => entry.configName + (entry.path ? ` → ${entry.path}` : "")))]
      return names.length ? [`${labels[kind]}：${names.join("、")}`] : []
    }))
  }
  if (runtime) {
    for (const kind of ["path", "identity"] as const) {
      const paths = [...new Set(runtime.references.filter((entry) => entry.kind === kind).map((entry) => entry.path))]
      if (paths.length) messages.push((kind === "path" ? "最近成功加载的运行文件引用此路径：" : "最近成功加载的运行文件通过其他路径关联同一文件：") + paths.join("、"))
    }
    if (runtime.hasSuccessfulRecord === true && runtime.scanComplete === true && !runtime.references.some((entry) => entry.kind === "path")) {
      messages.push("最近成功加载的运行文件未引用此路径")
    }
    if (runtime.hasSuccessfulRecord === false && runtime.unknownReason !== "no_record") messages.push("尚无成功加载记录")
    if (runtime.hasSuccessfulRecord !== false && runtime.scanComplete === false && runtime.unknownReason !== "record_unreadable") {
      messages.push("成功加载记录的引用检查不完整")
    }
    if (runtime.uncertain) {
      const reasons = {
        no_record: "尚无可读取的成功加载记录",
        load_pending: "加载结果尚未确认",
        load_unknown: "上次加载结果未知",
        load_failed: "上次应用失败，继续保留运行可能需要的文件",
        record_unreadable: "加载记录或运行文件无法完整检查",
        core_unverified: "成功加载记录不能持续确认 Core 当前完整依赖",
      }
      messages.push("运行依赖未知：" + reasons[runtime.unknownReason ?? "core_unverified"])
    }
  }
  return messages.join("；")
}

export function cleanupReason(item: CleanupOutcome) {
  const labels: Record<ProviderCleanupItem["reason"], string> = {
    unused: "归属明确，未发现配置及已记录运行文件引用",
    referenced: "配置仍在引用",
    runtime_reference: "最近成功加载的运行文件仍在引用",
    runtime_unknown: "运行依赖无法确认",
    maintained: "由订阅或本地配置提取维护",
    ownership_unknown: "外部文件或归属不明",
    unreadable: "文件不可读或不在受控普通文件范围",
    changed: "文件内容、身份或归属已变化",
    deleted: "已删除",
    delete_failed: "删除失败，文件保留；请重新读取",
  }
  if (item.reason === "deleted") return labels.deleted
  const evidence = providerReferenceMessage(item.configReferences, item.runtime)
  if (evidence) return (["referenced", "runtime_reference", "runtime_unknown"].includes(item.reason) ? "" : labels[item.reason] + "；") + evidence
  return labels[item.reason] + (item.configNames?.length ? `：${item.configNames.join("、")}` : "")
}

export function cleanupSummary(result: { files: CleanupOutcome[] }) {
  const removed = result.files.filter((item) => item.action === "deleted").length
  const kept = result.files.filter((item) => item.action === "keep")
  return `已清理 ${removed} 个文件` + (kept.length ? `；保留 ${kept.length} 个：${[...new Set(kept.map(cleanupReason))].join("；")}` : "")
}
