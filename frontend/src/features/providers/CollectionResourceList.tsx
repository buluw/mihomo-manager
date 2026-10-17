import { Server } from "lucide-react"

import { ResourceListGroup, ResourceListRow } from "@/components/patterns/resource-list"
import { Badge } from "@/components/ui/badge"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

import { useLayoutEffect, useRef, type ReactNode } from "react"
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
  emptyActions,
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
  emptyActions?: ReactNode
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
  const groups = [
    { label: "可编辑", entries: entries.filter(([name]) => effectiveWritableNames.has(name)), tone: "writable" as const },
    { label: "正在读取配置", entries: entries.filter(([name]) => effectivePendingNames.has(name) && !effectiveWritableNames.has(name)), tone: "pending" as const },
    { label: "需先加载配置", entries: entries.filter(([name]) => effectiveUnavailableNames.has(name)), tone: "unavailable" as const },
    { label: "只读", entries: entries.filter(([name]) => !effectiveWritableNames.has(name) && !effectivePendingNames.has(name) && !effectiveUnavailableNames.has(name)), tone: "readonly" as const },
  ].filter((group) => group.entries.length > 0)
  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)]">

      <div ref={scrollRef} onScroll={(e) => { categoryScrollTops[category] = e.currentTarget.scrollTop }} className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4 pt-1 pb-5 md:px-3">
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
            {emptyActions && <EmptyContent>{emptyActions}</EmptyContent>}
          </Empty>
        ) : (
          groups.map((group) => (
            <section key={group.label} className="grid shrink-0 gap-2">
              <div className={cn("px-3 text-xs", group.tone === "unavailable" ? "text-destructive" : "text-muted-foreground")}>{group.label}</div>
              <ResourceListGroup>
              {group.entries
                .sort(([left], [right]) => left.localeCompare(right, "zh-CN"))
                .map(([name, provider]) => {
            const displayName = providerDisplayName(name)
            return (
              <ResourceListRow key={name} selected={activeName === name} marked={activeName === name} onSelect={() => onSelect(name)}
                name={<>{displayName}{mergedNames.has(name) && <Badge variant="secondary" className="ml-1 text-[10px]">合并</Badge>}</>}
                metadata={descriptions[name] ?? `${providerSource(provider)} · ${providerItemCount(category, provider)} ${category === "proxy" ? "个节点" : "条规则"}`} />
            )
              })}
              </ResourceListGroup>
            </section>
          ))
        )}
      </div>
    </div>
  )
}
