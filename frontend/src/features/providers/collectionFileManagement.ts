import type { CollectionFileDraft, ConfigSnapshot, ManagedHttpProviderOwner, ManagedProviderFile, ProviderCleanupItem } from "../../api/configClient.ts"
import { parseDocument } from "yaml"
import { collectionFileName } from "./collectionNaming.ts"
import { managedProviderItems, normalizedReference, type ManagedProviderItem } from "./managedProviderModel.ts"
import type { ProviderCategory } from "./collectionViewModel.ts"

export type CollectionFileRow = {
  id: string; item: ManagedProviderItem; bindings: ManagedProviderItem[]; savedBindings: ManagedProviderItem[]
  fileName: string | null; referencePath: string | null; cleanup?: ProviderCleanupItem
  draft?: CollectionFileDraft; deleting: boolean
}

export function collectionSourceLabel(item: ManagedProviderItem) {
  if (item.httpCache) return "HTTP 缓存"
  return { inline: "配置内嵌", manual: "手动文件", external: "配置文件", http: "HTTP 下载", subscription: "订阅提取", local: "配置提取" }[item.access]
}

export function collectionFileRows(snapshot: ConfigSnapshot, content: string, files: ManagedProviderFile[], owners: ManagedHttpProviderOwner[], category: ProviderCategory, drafts: CollectionFileDraft[], cleanup: ProviderCleanupItem[], removed: ProviderCleanupItem[], awaitingApplication = false) {
  const current = managedProviderItems({ ...snapshot, content }, files, category, owners)
  const saved = parseDocument(snapshot.content).errors.length ? [] : managedProviderItems(snapshot, files, category, owners).filter(item => item.declared)
  const rows = new Map<string, CollectionFileRow>()
  const key = (item: ManagedProviderItem) => item.access === "inline" || item.access === "http" ? item.id : `${category}:file:${normalizedReference(item.referencePath) || item.id}`
  for (const item of [...current, ...saved]) {
    const id = key(item)
    if (!rows.has(id)) rows.set(id, { id, item, bindings: current.filter(entry => entry.declared && key(entry) === id), savedBindings: saved.filter(entry => key(entry) === id), fileName: item.fileName, referencePath: item.referencePath, deleting: false })
  }
  for (const row of rows.values()) {
    row.draft = drafts.find(entry => entry.category === category && entry.fileName === row.fileName)
    row.cleanup = cleanup.find(entry => entry.category === category && entry.fileName === row.fileName)
    row.deleting = (awaitingApplication && Boolean(row.cleanup?.pendingConfigNames?.includes(snapshot.name))) || removed.some(entry => entry.category === category && entry.fileName === row.fileName)
    if (!row.bindings.length) row.item = { ...row.item, declared: false }
  }
  return [...rows.values()].sort((a, b) => (a.fileName ?? a.item.name).localeCompare(b.fileName ?? b.item.name, "zh-CN"))
}

export function renamedCollectionFile(row: Pick<CollectionFileRow, "fileName" | "referencePath">, name: string) {
  if (!row.fileName || !row.referencePath) throw new Error("集合文件身份尚未确认")
  const leaf = collectionFileName(name)
  return { fileName: row.fileName.replace(/[^/]+$/, leaf), referencePath: row.referencePath.replace(/[^/]+$/, leaf) }
}

export function replaceCollectionFilePath(content: string, bindings: ManagedProviderItem[], path: string) {
  const document = parseDocument(content)
  if (document.errors.length) throw new Error("请先修正配置 YAML")
  for (const item of bindings) document.setIn([item.category + "-providers", item.name, "path"], path)
  return document.toString({ lineWidth: 0 })
}
