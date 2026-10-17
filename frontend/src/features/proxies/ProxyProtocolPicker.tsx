import { MobileSheetContent } from "@/components/patterns/mobile-sheet"
import { MobileChoiceRow } from "@/components/patterns/mobile-choice-sheet"
import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { proxyProtocolOptionColumns, type ProxyDelaySample } from "./proxyLogic";

export type ProxyProtocolOption = { name: string; protocol: string; delaySample: ProxyDelaySample };

export function ProxyProtocolPicker({ name, label, protocol, options, onChoose }: {
  name: string;
  label: string;
  protocol: string;
  options: ProxyProtocolOption[];
  onChoose: (name: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const choose = async (next: string) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(next);
    try { if (await onChoose(next)) setOpen(false); }
    finally { pendingRef.current = false; setPending(null); }
  };
  const delayClass = (delay: number | null) => !delay || delay > 800 ? "text-destructive" : delay >= 300 ? "text-status-warning" : "text-status-success";
  return (
    <>
      <Sheet open={open} onOpenChange={(next) => { if (!pendingRef.current) setOpen(next); }}>
        <SheetTrigger onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} render={<Button variant="ghost" size="sm" className="col-start-1 row-start-1 h-11 max-w-36 min-w-0 justify-start px-0 sm:hidden" aria-label={`${label} 当前协议 ${protocol}`} />}>
          <ChevronDown data-icon="inline-start" /><span className="truncate">{protocol}</span>
        </SheetTrigger>
        <MobileSheetContent title={"选择协议 · " + label} bodyClassName="flex flex-col gap-1" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
          {options.map(option => {
            const columns = proxyProtocolOptionColumns(option.name, option.protocol, option.delaySample);
            return <MobileChoiceRow key={option.name} label={columns.name} selected={name === option.name} pending={pending === option.name} disabled={pending !== null}
              description={<span className="flex items-center gap-3"><span>{columns.protocol}</span><span className={cn("font-mono tabular-nums", delayClass(option.delaySample.delay))}>{columns.delayLabel}</span></span>} onChoose={() => void choose(option.name)} />;
          })}
        </MobileSheetContent>
      </Sheet>
      <DropdownMenu>
        <DropdownMenuTrigger onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} render={<Button variant="ghost" size="sm" className="col-start-3 row-start-1 hidden h-7 w-full min-w-0 justify-start justify-self-stretch rounded-sm px-4 text-[13px] text-foreground hover:bg-transparent hover:text-mode-rule aria-expanded:bg-transparent dark:hover:bg-transparent sm:flex" aria-label={`${label} 当前协议 ${protocol}`} />}>
          <span className="flex w-4 shrink-0 items-center justify-center"><ChevronDown /></span><span className="truncate text-left">{protocol}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-[min(24rem,calc(100vw-1rem))]">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{label}</DropdownMenuLabel>
            <div className="grid grid-cols-[minmax(0,1fr)_88px_64px] gap-2 px-2 py-1 text-[11px] text-muted-foreground"><span>节点原名</span><span>协议</span><span className="text-right">延迟</span></div>
            <DropdownMenuRadioGroup value={name} onValueChange={(next) => void onChoose(next)}>
              {options.map((option) => { const columns = proxyProtocolOptionColumns(option.name, option.protocol, option.delaySample); return <DropdownMenuRadioItem key={option.name} value={option.name} className="grid grid-cols-[minmax(0,1fr)_88px_64px] gap-2 pr-8" onClick={(event) => event.stopPropagation()}>
                <Tooltip><TooltipTrigger render={<span className="min-w-0 truncate" />}>{columns.name}</TooltipTrigger><TooltipContent>{columns.name}</TooltipContent></Tooltip>
                <span className="truncate">{columns.protocol}</span>
                <span className={cn("justify-self-end font-mono text-xs tabular-nums", delayClass(option.delaySample.delay))}>{columns.delayLabel}</span>
              </DropdownMenuRadioItem>; })}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
