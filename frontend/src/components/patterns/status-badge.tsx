import type { ComponentProps } from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const statusClasses = {
  success: "[--status-badge-color:var(--status-success)]",
  warning: "[--status-badge-color:var(--status-warning)]",
  info: "[--status-badge-color:var(--status-info)]",
  error: "[--status-badge-color:var(--destructive)]",
  neutral: "[--status-badge-color:var(--muted-foreground)]",
}

export type StatusTone = keyof typeof statusClasses

export function StatusBadge({ status, className, ...props }: Omit<ComponentProps<typeof Badge>, "variant"> & { status: StatusTone }) {
  return <Badge variant="secondary" className={cn(
    "bg-[color-mix(in_oklab,var(--status-badge-color)_12%,transparent)] text-[color-mix(in_oklab,var(--status-badge-color)_70%,var(--foreground))]",
    statusClasses[status], className,
  )} {...props} />
}
