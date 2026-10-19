import { ArrowDown, ArrowUp, ChevronDown } from "lucide-react"
import { MobileChoiceSheet } from "@/components/patterns/mobile-choice-sheet"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { ProxySortDirection, ProxySortKey } from "./proxyLogic"

const labels: Record<ProxySortKey, string> = { name: "名称", protocol: "协议", region: "地区", latency: "延迟" }

export function ProxySortMenu({ sortKey, direction, onSort }: { sortKey: ProxySortKey; direction: ProxySortDirection; onSort: (key: ProxySortKey) => void }) {
  const content = <>{direction === "asc" ? <ArrowUp data-icon="inline-start" /> : <ArrowDown data-icon="inline-start" />}{labels[sortKey]}<ChevronDown data-icon="inline-end" /></>
  return <>
    <MobileChoiceSheet title="节点排序" value={sortKey}
      options={(Object.keys(labels) as ProxySortKey[]).map(key => ({ value: key, label: "按" + labels[key], description: key === sortKey ? (direction === "asc" ? "升序 · 再次选择切换为降序" : "降序 · 再次选择切换为升序") : undefined }))}
      onChoose={key => onSort(key as ProxySortKey)} trigger={<Button variant="ghost" size="lg" className="h-10 shrink-0 md:hidden" aria-label="节点排序">{content}</Button>} />
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="lg" className="hidden h-10 shrink-0 md:inline-flex" aria-label="节点排序" />}>{content}</DropdownMenuTrigger>
      <DropdownMenuContent align="end"><DropdownMenuGroup><DropdownMenuLabel>节点排序</DropdownMenuLabel>
        {(Object.keys(labels) as ProxySortKey[]).map(key => <DropdownMenuItem key={key} onClick={() => onSort(key)}><span className="flex-1">按{labels[key]}</span>{sortKey === key && (direction === "asc" ? <ArrowUp /> : <ArrowDown />)}</DropdownMenuItem>)}
      </DropdownMenuGroup></DropdownMenuContent>
    </DropdownMenu>
  </>
}
