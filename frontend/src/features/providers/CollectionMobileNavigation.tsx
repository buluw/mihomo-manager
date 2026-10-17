import { ArrowLeft, ChevronDown } from "lucide-react"

import { MobileChoiceSheet } from "@/components/patterns/mobile-choice-sheet"
import { Button } from "@/components/ui/button"
import type { ProviderCategory } from "./collectionViewModel"

const categories = [
  { value: "proxy", label: "代理集合" },
  { value: "rule", label: "规则集合" },
]

export function CollectionCategoryPicker({ category, disabled, onChoose }: {
  category: ProviderCategory
  disabled: boolean
  onChoose: (category: ProviderCategory) => boolean
}) {
  return <div className="flex min-h-13 shrink-0 items-center px-4 py-1" data-slot="collection-category">
    <MobileChoiceSheet title="切换分类" value={category} options={categories}
      onChoose={value => onChoose(value as ProviderCategory)}
      trigger={<Button variant="ghost" size="sm" disabled={disabled} aria-label="切换分类" className="min-h-11 gap-1 px-0 max-md:text-base">
        {categories.find(item => item.value === category)?.label}<ChevronDown data-icon="inline-end" />
      </Button>} />
  </div>
}

export function CollectionDetailHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return <div className="flex min-h-13 shrink-0 items-center gap-2 px-4 py-1 md:hidden" data-slot="collection-title">
    <Button variant="ghost" size="icon" className="size-11 shrink-0" onClick={onBack} aria-label="返回集合列表"><ArrowLeft /></Button>
    <span className="min-w-0 text-sm font-medium wrap-anywhere">{title}</span>
  </div>
}
