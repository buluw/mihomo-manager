import { useEffect, useRef, useState } from "react"
import { ArrowLeft, Plus, RotateCcw, Save, Search, X } from "lucide-react"

import { StatusDot } from "@/components/patterns/page-kit"
import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { cn } from "@/lib/utils"
import { RuleChoicePicker } from "./RuleChoicePicker"

type FilterItem = { label: string; value: string }

export function RuleListToolbar({
  query,
  onQueryChange,
  typeFilter,
  filterItems,
  onTypeFilterChange,
  dirty,
  busy,
  editing,
  canEdit,
  pendingApply,
  onDiscard,
  onSave,
  onCreate,
}: {
  query: string
  onQueryChange: (value: string) => void
  typeFilter: string
  filterItems: FilterItem[]
  onTypeFilterChange: (value: string) => void
  dirty: boolean
  busy: boolean
  editing: boolean
  canEdit: boolean
  pendingApply: boolean
  onDiscard: () => void
  onSave: () => void
  onCreate: () => void
}) {
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (mobileSearchOpen) searchRef.current?.focus() }, [mobileSearchOpen])
  const draftActions = <>
    <Button aria-label="放弃更改" variant="outline" size="sm" disabled={busy} onClick={onDiscard}><RotateCcw data-icon="inline-start" />放弃</Button>
    <Button aria-label="保存并加载" size="sm" disabled={(!dirty && !pendingApply) || busy} onClick={onSave}><Save data-icon="inline-start" />保存并加载</Button>
  </>
  return (
    <div aria-label="规则工具栏" className="@container/rule-toolbar grid min-h-12 gap-2 border-b bg-muted/10 px-3 py-2 lg:grid-cols-[minmax(180px,280px)_minmax(0,1fr)] lg:items-center">
      <div className="flex min-w-0 items-center gap-2 sm:contents">
      <InputGroup className={cn("h-8 min-w-0 flex-1 sm:flex", !mobileSearchOpen && "hidden")}>
        <InputGroupInput
          ref={searchRef}
          aria-label="搜索规则"
          placeholder="搜索类型、内容或策略"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <InputGroupAddon align="inline-start"><Search /></InputGroupAddon>
        {query && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton size="icon-xs" aria-label="清空规则搜索" onClick={() => onQueryChange("")}>
              <X />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
      {mobileSearchOpen && <Button variant="outline" size="icon" className="size-11 sm:hidden" aria-label="收起规则搜索" onClick={() => { searchRef.current?.blur(); setMobileSearchOpen(false) }}><ArrowLeft /></Button>}
      <div className={cn("flex min-w-0 flex-1 items-center gap-2 sm:flex sm:flex-wrap sm:justify-end", mobileSearchOpen && "hidden")}>
        <span className={cn("hidden shrink-0 items-center gap-1.5 text-xs text-status-warning sm:flex", !dirty && !pendingApply && "sm:invisible")}>
          <StatusDot tone="warn" />{dirty ? "未保存" : "待加载"}
        </span>
        <RuleChoicePicker
          kind="type"
          label="筛选规则类型"
          options={filterItems}
          value={typeFilter}
          onChoose={(value) => { onTypeFilterChange(value); return true }}
        />
        <Button variant={query.trim() ? "secondary" : "outline"} size="icon" className="size-11 sm:hidden" aria-label={query.trim() ? "搜索规则（筛选中）" : "搜索规则"} aria-expanded={mobileSearchOpen} aria-pressed={Boolean(query.trim())} onClick={() => setMobileSearchOpen(true)}><Search /></Button>
        <Button variant="outline" size="sm" className="max-sm:size-11 @min-[360px]/rule-toolbar:max-sm:w-auto" aria-label="新建规则" disabled={!canEdit || busy} onClick={onCreate}><Plus data-icon="inline-start" /><span className="hidden @min-[360px]/rule-toolbar:inline sm:inline">新建规则</span></Button>
        {editing && <div className="hidden sm:contents">{draftActions}</div>}
      </div>
      </div>
      {(editing || dirty || pendingApply) && <div className="flex min-w-0 items-center gap-2 sm:hidden">
        <span role="status" className="mr-auto flex items-center gap-1.5 text-xs text-status-warning"><StatusDot tone="warn" />{dirty ? "未保存" : pendingApply ? "待加载" : "规则草稿"}</span>
        {editing && draftActions}
      </div>
      }
    </div>
  )
}
