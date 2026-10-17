import { ArrowLeft, ChevronDown } from "lucide-react"

import { MobileChoiceSheet } from "@/components/patterns/mobile-choice-sheet"
import { Button } from "@/components/ui/button"

export type ConfigSection = "files" | "subscriptions" | "merge"

const categories = [
  { value: "files", label: "配置文件" },
  { value: "subscriptions", label: "订阅" },
  { value: "merge", label: "代理集提取" },
]

export function ConfigCategoryPicker({ section, disabled, onChoose }: {
  section: ConfigSection
  disabled: boolean
  onChoose: (section: ConfigSection) => Promise<boolean>
}) {
  return <MobileChoiceSheet title="切换分类" value={section} options={categories}
    onChoose={value => onChoose(value as ConfigSection)}
    trigger={<Button variant="ghost" size="sm" disabled={disabled} aria-label="切换分类" className="min-h-11 shrink-0 gap-1 px-0 max-md:text-base">
      {categories.find(item => item.value === section)?.label}<ChevronDown data-icon="inline-end" />
    </Button>} />
}

export function ConfigDetailHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return <div className="flex min-h-17 shrink-0 items-center gap-2 border-b px-4 py-3 md:hidden">
    <Button variant="ghost" size="icon" aria-label="返回列表" className="size-11 shrink-0" onClick={onBack}><ArrowLeft /></Button>
    <span className="min-w-0 text-sm font-medium wrap-anywhere">{title}</span>
  </div>
}
