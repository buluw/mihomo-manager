import { Eye, MapPinned, RefreshCw } from "lucide-react"
import { StatusDot } from "@/components/patterns/page-kit"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { Json } from "@/shared/types"
import type { ProxyProtocolOption } from "./ProxyProtocolPicker"
import { proxyDelayFailureLabel, proxyProtocolDisplayName, proxyProtocolOptionColumns, proxyRegionDisplayLabel, type ProxyDelaySample } from "./proxyLogic"

function delayTone(delay: number | null) {
  if (!delay || delay > 800) return "error" as const
  if (delay >= 300) return "warn" as const
  return "ok" as const
}

function NodeDetails({
  name,
  label,
  node,
  delay,
  testedAt,
  failure,
  country,
  options,
  identifyingCountries,
  loading,
  onIdentifyCountries,
  onRefresh,
}: {
  name: string;
  label: string;
  node: Json;
  delay: number | null;
  testedAt: number;
  failure?: ProxyDelaySample["failure"];
  country: string | null;
  options: ProxyProtocolOption[];
  identifyingCountries: boolean;
  loading: boolean;
  onIdentifyCountries: () => void;
  onRefresh: () => void;
}) {
  const protocol = proxyProtocolDisplayName(options.find((option) => option.name === name)?.protocol
    || String(node.type || "未知"));
  const sample = { delay, testedAt, failure };
  return (
    <div className="p-3">
      <div className="flex items-center gap-2 leading-none">
        <StatusDot tone={delayTone(delay)} />
        <span className="text-[13px] font-semibold leading-tight">{label}</span>
      </div>
      <dl className="mt-3 flex flex-col gap-2.5 text-[13px]">
        <div className="flex items-center gap-2">
          <dt className="text-muted-foreground">地区</dt>
          <dd className="ml-auto flex min-w-0 items-center gap-1.5">
            <span className="truncate">{proxyRegionDisplayLabel(country)}</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={identifyingCountries}
                    onClick={onIdentifyCountries}
                    aria-label="识别地区"
                  />
                }
              >
                {identifyingCountries ? <Spinner /> : <MapPinned />}
                <span className="sr-only">识别地区</span>
              </TooltipTrigger>
              <TooltipContent>识别地区</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={loading}
                    onClick={onRefresh}
                    aria-label="刷新代理数据"
                  />
                }
              >
                {loading ? <Spinner /> : <RefreshCw />}
                <span className="sr-only">刷新代理数据</span>
              </TooltipTrigger>
              <TooltipContent>刷新代理数据</TooltipContent>
            </Tooltip>
          </dd>
        </div>
        <div className="flex">
          <dt className="text-muted-foreground">当前协议</dt>
          <dd className="ml-auto">{protocol}</dd>
        </div>
        <div className="flex">
          <dt className="text-muted-foreground">当前延迟</dt>
          <dd className={cn("ml-auto font-mono text-xs", proxyDelayFailureLabel(sample) && "text-destructive")}>{proxyProtocolOptionColumns(name, protocol, sample).delayLabel}</dd>
        </div>
        <div className="flex">
          <dt className="text-muted-foreground">成员协议</dt>
          <dd className="ml-auto">{options.length}</dd>
        </div>
      </dl>
      <Separator className="mt-3" />
      <div className="pt-2">
        {options.map((option) => (
          <div className="flex h-8 items-center text-[13px] leading-none" key={option.name}>
          <StatusDot tone={delayTone(option.delaySample.delay)} />
            <span className="ml-2 leading-tight">{proxyProtocolDisplayName(option.protocol)}</span>
            <span className={cn("ml-auto font-mono text-xs", proxyDelayFailureLabel(option.delaySample) ? "text-destructive" : "text-muted-foreground")}>
              {proxyProtocolOptionColumns(option.name, option.protocol, option.delaySample).delayLabel}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export type ProxyNodeDetailsProps = Parameters<typeof NodeDetails>[0]

export function ProxyNodeDetails({ cardStyle = false, className, ...props }: ProxyNodeDetailsProps & { cardStyle?: boolean; className?: string }) {
  return <Dialog>
    <DialogTrigger onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
      render={<Button variant="ghost" size="icon" aria-label={"查看 " + props.label + " 详情"}
        className={cn(className, cardStyle && "pointer-events-auto -mr-1.5 size-8 rounded-full bg-transparent text-muted-foreground hover:bg-foreground/8 hover:text-foreground dark:hover:bg-foreground/8 active:translate-y-0 max-md:min-h-8 max-md:min-w-8 max-md:[&_svg:not([class*=size-])]:size-3.5")} />}>
      <Eye /><span className="sr-only">{"查看 " + props.label + " 详情"}</span>
    </DialogTrigger>
    <DialogContent>
      <DialogHeader><DialogTitle>{props.label}</DialogTitle><DialogDescription>{proxyRegionDisplayLabel(props.country)} · {props.options.length} 个成员协议</DialogDescription></DialogHeader>
      <NodeDetails {...props} />
    </DialogContent>
  </Dialog>
}
