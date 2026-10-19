import { useState, type ReactNode } from "react"
import { ArrowRight, ChevronDown, ChevronUp, TriangleAlert } from "lucide-react"
import type { ProviderFileIssue } from "@/api/configClient"
import { providerFileIssueLabel } from "@/shared/configMessages"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

export function CollectionIssuesNotice({ issues, disabled, onRepair, children }: {
  issues: Array<ProviderFileIssue & { path?: string }>
  disabled?: boolean
  onRepair?: (issue: ProviderFileIssue) => void
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  if (!issues.length && !children) return null
  const missing = issues.filter(issue => issue.status === "missing")
  const counts = [...new Set(issues.map(issue => issue.status))].map(status => providerFileIssueLabel(status) + " " + issues.filter(issue => issue.status === status).length + " 个")
  return <Collapsible open={open} onOpenChange={setOpen} className="shrink-0">
    <Alert className="rounded-none border-x-0 px-3 py-1">
      <AlertDescription className="min-w-0">
        <div className="flex min-h-10 flex-wrap items-center justify-start gap-2">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span className="shrink-0">{missing.length === issues.length && missing.length ? "缺少 " + missing.length + " 个集合" : issues.length ? issues.length + " 个集合需处理" : "集合路径需确认"}</span>
          {missing.length > 0 && onRepair && <Button variant="outline" size="sm" disabled={disabled} onClick={() => onRepair(missing[0]!)}>补齐集合<ArrowRight data-icon="inline-end" /></Button>}
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" />} aria-label={open ? "收起集合问题详情" : "查看集合问题详情"}>详情{open ? <ChevronUp data-icon="inline-end" /> : <ChevronDown data-icon="inline-end" />}</CollapsibleTrigger>
        </div>
        <CollapsibleContent className="max-h-40 overflow-y-auto overscroll-contain pb-2">
          <p className="py-2 text-xs text-muted-foreground">{counts.join("；")}</p>
          <ul className="flex flex-col gap-2" aria-label="集合问题详情">
            {issues.map(issue => <li key={issue.category + ":" + issue.name} className="min-w-0 text-xs">
              <div className="flex flex-wrap gap-x-2"><span>{issue.name}</span><span>{providerFileIssueLabel(issue.status)}</span></div>
              {issue.path && <p className="break-all text-muted-foreground">{issue.path}</p>}
            </li>)}
          </ul>
          {children}
        </CollapsibleContent>
      </AlertDescription>
    </Alert>
  </Collapsible>
}
