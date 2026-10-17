import type { ConfigSubscription, ConfigSubscriptionInput } from "@/api/configClient"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { FileDown, Save } from "lucide-react"
import {
  SUBSCRIPTION_INTERVAL_PRESETS,
  subscriptionIntervalLabel,
  subscriptionIntervalOption,
} from "./subscriptionWorkspaceState"

function displayDate(value: string | null) {
  if (!value) return "尚未更新"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "更新时间不可用" : date.toLocaleString()
}

export function SubscriptionEditor({
  form,
  item,
  disabled,
  onChange,
  filterDraft,
  filterError,
  filterPreview,
  filterPreviewPending,
  onFilterChange,
  onFilterPreview,
  onFilterSave,
}: {
  form: ConfigSubscriptionInput
  item: ConfigSubscription | null
  disabled: boolean
  onChange: (patch: Partial<ConfigSubscriptionInput>) => void
  filterDraft: { enabled: boolean; rules: string }
  filterError: string | null
  filterPreview: { totalCount: number; remainingCount: number; matchedNames: string[] } | null
  filterPreviewPending: boolean
  onFilterChange: (patch: Partial<{ enabled: boolean; rules: string }>) => void
  onFilterPreview: () => void
  onFilterSave: () => void
}) {
  const intervalOption = subscriptionIntervalOption(form.intervalMinutes)

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="max-w-2xl">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="subscription-name">名称</FieldLabel>
            <Input
              id="subscription-name"
              value={form.name}
              autoFocus={!item}
              disabled={disabled}
              onChange={(event) => onChange({ name: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="subscription-url">订阅地址</FieldLabel>
            <Input
              id="subscription-url"
              type="url"
              autoComplete="off"
              value={form.url ?? ""}
              disabled={disabled}
              placeholder="https://..."
              onChange={(event) => onChange({ url: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel>最后更新时间</FieldLabel>
            <div className="flex h-8 items-center rounded-md border bg-input/20 px-3 text-sm text-muted-foreground">
              {displayDate(item?.lastUpdatedAt ?? null)}
            </div>
          </Field>
          <Field orientation="horizontal">
            <div className="min-w-0 flex-1">
              <FieldLabel htmlFor="subscription-auto">自动更新</FieldLabel>
              <FieldDescription>
                由 configd 按周期更新，不依赖浏览器保持打开。
              </FieldDescription>
            </div>
            <Switch
              id="subscription-auto"
              checked={form.autoUpdate}
              disabled={disabled}
              onCheckedChange={(checked) => onChange({ autoUpdate: checked })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="subscription-interval">更新周期</FieldLabel>
            <Select
              value={intervalOption}
              disabled={disabled || !form.autoUpdate}
              onValueChange={(value) => {
                if (value && value !== "custom") onChange({ intervalMinutes: Number(value) })
              }}
            >
              <SelectTrigger id="subscription-interval" className="w-full">
                <SelectValue>{intervalOption === "custom" ? "自定义" : subscriptionIntervalLabel(form.intervalMinutes)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {SUBSCRIPTION_INTERVAL_PRESETS.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>
                      {subscriptionIntervalLabel(minutes)}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">自定义</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          {intervalOption === "custom" && (
            <Field>
              <FieldLabel htmlFor="subscription-custom-interval">自定义周期（分钟）</FieldLabel>
              <Input
                id="subscription-custom-interval"
                type="number"
                min={1}
                step={1}
                value={form.intervalMinutes}
                disabled={disabled || !form.autoUpdate}
                onChange={(event) => onChange({ intervalMinutes: Number(event.target.value) })}
              />
            </Field>
          )}
          {item && <div className="grid gap-4 border-t pt-5">
            <Field orientation="horizontal"><div className="min-w-0 flex-1"><FieldLabel htmlFor="subscription-filter">过滤节点</FieldLabel><FieldDescription>过滤下载得到的完整订阅配置，不依赖 Provider 提取关系。</FieldDescription></div><Switch id="subscription-filter" checked={filterDraft.enabled} disabled={disabled} onCheckedChange={(enabled) => onFilterChange({ enabled })} /></Field>
            <Field data-invalid={Boolean(filterError)}><FieldLabel htmlFor="subscription-filter-rules">过滤规则</FieldLabel><Textarea id="subscription-filter-rules" className="min-h-40" value={filterDraft.rules} disabled={disabled} onChange={(event) => onFilterChange({ rules: event.target.value })} /><FieldDescription>每行一条；普通文字支持 `&` 全词组合，`/表达式/flags` 表示正则。内置规则可直接编辑或删除。</FieldDescription><FieldError>{filterError}</FieldError></Field>
            <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={disabled || filterPreviewPending || Boolean(filterError)} onClick={onFilterPreview}>{filterPreviewPending ? <Spinner data-icon="inline-start" /> : <FileDown data-icon="inline-start" />}预览</Button><Button type="button" disabled={disabled || Boolean(filterError)} onClick={onFilterSave}><Save data-icon="inline-start" />保存过滤</Button></div>
            {filterPreview && <div className="rounded-md border bg-muted/20 p-3 text-xs"><div className="font-medium">匹配 {filterPreview.matchedNames.length} / {filterPreview.totalCount}，将保留 {filterPreview.remainingCount}</div><div className="mt-2 text-muted-foreground">{filterPreview.matchedNames.join("、") || "没有命中节点"}</div></div>}
          </div>}
        </FieldGroup>
      </div>
    </div>
  )
}
