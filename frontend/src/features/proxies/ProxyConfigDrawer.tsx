import { MobileSheetContent } from "@/components/patterns/mobile-sheet"
import { MobileChoiceRow } from "@/components/patterns/mobile-choice-sheet"
import { useState } from "react";
import { FileSliders } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Sheet, SheetTrigger } from "@/components/ui/sheet";
import type { useProxyConfigSwitcher } from "./useProxyConfigSwitcher";

export function ProxyConfigDrawer({ switcher }: { switcher: ReturnType<typeof useProxyConfigSwitcher> }) {
  const [open, setOpen] = useState(false);
  return <Sheet open={open} onOpenChange={(next) => { if (!switcher.busy) setOpen(next); }}>
    <SheetTrigger render={<Button variant="ghost" size="sm" className="ml-auto h-11 min-w-0 max-w-[55%] md:hidden" aria-label="切换运行配置" />}>
      <FileSliders data-icon="inline-start" /><span className="truncate">{switcher.loaded || "配置身份未知"}</span>
    </SheetTrigger>
    <MobileSheetContent title="切换运行配置" description="点选配置后校验并加载，点选当前配置可重载。" bodyClassName="flex flex-col gap-1">
      {switcher.listMessage && <Alert className="mb-3"><AlertDescription>{switcher.listMessage}</AlertDescription></Alert>}
      {switcher.listLoading && <p role="status" className="px-4 py-2">正在读取配置列表</p>}
      {switcher.files.map(file => <MobileChoiceRow key={file.name} label={file.name} selected={file.name === switcher.loaded}
        description={file.name === switcher.loaded ? "点选可重载当前配置" : undefined} pending={switcher.busy && switcher.target === file.name} disabled={switcher.busy}
        onChoose={() => { void switcher.apply(file.name).then(success => { if (success) setOpen(false) }) }} />)}
    </MobileSheetContent>
  </Sheet>;
}
