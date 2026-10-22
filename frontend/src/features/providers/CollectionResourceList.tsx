import { Server } from "lucide-react"

import { ResourceListGroup, ResourceListRow } from "@/components/patterns/resource-list"
import { Badge } from "@/components/ui/badge"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"

import { useLayoutEffect, useRef } from "react"
import {
  providerDisplayName,
  providerItemCount,
  providerSource,
  type ProviderCategory,
  type ProviderPayload,
} from "./collectionViewModel"

const categoryScrollTops: Record<ProviderCategory, number> = { proxy: 0, rule: 0 }

export function CollectionResourceList({
  category,
  entries,
  activeName,
  loading,
  error,
  onSelect,
  writableNames = new Set<string>(),
  unavailableNames = new Set<string>(),
  pendingNames = new Set<string>(),
  mergedNames = new Set<string>(),
  descriptions = {},
  statuses = {},
}: {
  category: ProviderCategory
  entries: Array<[string, ProviderPayload]>
  activeName: string | undefined
  loading: boolean
  error: string | undefined
  onSelect: (name: string) => void
  writableNames?: ReadonlySet<string>
  unavailableNames?: ReadonlySet<string>
  pendingNames?: ReadonlySet<string>
  mergedNames?: ReadonlySet<string>
  descriptions?: Record<string, string>
  statuses?: Record<string, string>
}) {
  const effectiveWritableNames = writableNames
  const effectiveUnavailableNames = unavailableNames
  const effectivePendingNames = pendingNames
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = categoryScrollTops[category] ?? 0
    }
  }, [category])
  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)]">

      <div ref={scrollRef} onScroll={(e) => { categoryScrollTops[category] = e.currentTarget.scrollTop }} className="flex min-h-0 flex-col overflow-y-auto p-2">
        {entries.length === 0 ? (
          <Empty className="rounded-none p-3">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {loading ? <Spinner /> : <Server />}
              </EmptyMedia>
              <EmptyTitle>
                {loading
                  ? "正在读取"
                  : `没有${category === "proxy" ? "代理集合" : "规则集合"}`}
              </EmptyTitle>
              <EmptyDescription>
                {error ||
                  (loading
                    ? "正在从 Controller 读取 Provider。"
                    : "当前源配置没有此类集合。")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
              <ResourceListGroup>
              {[...entries]
                .sort(([left], [right]) => Number(effectiveWritableNames.has(right)) - Number(effectiveWritableNames.has(left)) || left.localeCompare(right, "zh-CN"))
                .map(([name, provider]) => {
            const displayName = providerDisplayName(name)
            return (
              <ResourceListRow key={name} selected={activeName === name} onSelect={() => onSelect(name)}
                name={<>{displayName}{mergedNames.has(name) && <Badge variant="secondary" className="ml-1 text-[10px]">合并</Badge>}</>}
                status={statuses[name] ?? (effectivePendingNames.has(name) ? "正在读取" : effectiveUnavailableNames.has(name) ? "需加载" : effectiveWritableNames.has(name) ? "可编辑" : "只读")}
                metadata={descriptions[name] ?? `${providerSource(provider)} · ${providerItemCount(category, provider)} ${category === "proxy" ? "个节点" : "条规则"}`} />
            )
              })}
              </ResourceListGroup>
        )}
      </div>
    </div>
  )
}
