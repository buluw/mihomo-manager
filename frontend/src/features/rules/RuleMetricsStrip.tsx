import { Ruler, ShieldCheck, Workflow } from "lucide-react"

const metrics = [
  { key: "total", label: "配置规则", icon: Ruler },
  { key: "types", label: "规则类型", icon: Workflow },
  { key: "visible", label: "当前显示", icon: ShieldCheck },
] as const

export function RuleMetricsStrip({
  total,
  types,
  visible,
}: {
  total: number
  types: number
  visible: number
}) {
  const values = { total, types, visible }

  return (
    <dl className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 sm:grid sm:grid-cols-3 sm:gap-3 sm:border-0 sm:bg-transparent sm:p-0">
      {metrics.map((metric) => {
        const Icon = metric.icon
        return (
          <div
            key={metric.key}
            className="flex min-w-0 items-center gap-1.5 sm:grid sm:h-[72px] sm:grid-cols-[18px_minmax(0,1fr)] sm:grid-rows-2 sm:gap-x-2 sm:gap-y-0 sm:rounded-md sm:border sm:bg-background sm:px-3 sm:py-2"
          >
            <Icon className="hidden size-4 text-primary sm:row-span-2 sm:block" />
            <dd className="order-last text-sm leading-none font-semibold tabular-nums sm:order-none sm:self-end sm:text-lg">{values[metric.key]}</dd>
            <dt className="truncate text-[11px] text-muted-foreground sm:self-start">{metric.label}</dt>
          </div>
        )
      })}
    </dl>
  )
}
