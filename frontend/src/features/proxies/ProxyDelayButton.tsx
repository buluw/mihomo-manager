import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { ControllerDelayFailure } from "@/api/controllerClient"
import { proxyDelayFailureLabel } from "./proxyLogic"

export function ProxyDelayButton({ name, delay, testedAt, testing, queued, failure, disabled, onTest, cardStyle = false, className }: {
  name: string
  delay: number | null
  testedAt: number
  testing: boolean
  queued: boolean
  failure?: ControllerDelayFailure
  disabled: boolean
  onTest: () => void
  cardStyle?: boolean
  className?: string
}) {
  const failureLabel = proxyDelayFailureLabel({ delay, testedAt, failure })
  const cardDelayText = "text-[18px] leading-7 font-medium tracking-[-0.04em] md:text-[25px] md:font-semibold"
  const tone = testing ? "text-muted-foreground hover:text-muted-foreground"
    : !delay || delay > 800 ? "text-destructive hover:text-destructive"
    : delay >= 300 ? "text-status-warning hover:text-status-warning" : "text-status-success hover:text-status-success"
  return <Tooltip>
    <TooltipTrigger render={<Button variant="ghost" size="lg" disabled={disabled} aria-busy={testing} aria-label={"测试 " + name + " 延迟"}
      onClick={event => { event.stopPropagation(); onTest() }} onKeyDown={event => event.stopPropagation()}
      className={cn("h-11 shrink-0 justify-end gap-[3px] bg-transparent px-0 tabular-nums hover:bg-transparent dark:hover:bg-transparent active:translate-y-0 has-data-[icon=inline-start]:pl-0 [&>span]:underline-offset-4 hover:[&>span]:underline hover:[&>span]:decoration-1",
        cardStyle ? "pointer-events-auto w-[60px] min-w-[60px] items-baseline py-2 max-md:min-w-[60px] md:w-[76px] md:min-w-[76px]" : "w-full font-mono text-xs",
        cardStyle && testing && "items-center", tone, className)} />}>
      {testing ? <span role="status" aria-label={queued ? "等待测速" : "测量中"} className="inline-flex h-7 items-center gap-1">
        {["[animation-delay:-600ms]", "[animation-delay:-300ms]", "[animation-delay:0ms]"].map(delayClass =>
          <span key={delayClass} aria-hidden="true" className={cn("flex h-4 w-1 animate-bounce items-center [animation-duration:900ms]", delayClass)}><span className="size-1 rounded-full bg-current" /></span>)}
      </span>
        : delay ? <><span className={cn(cardStyle && cardDelayText)}>{delay}</span><span className={cn(cardStyle && "text-[10px] font-normal")}>ms</span></>
        : <span className={cn("text-xs", cardStyle && failureLabel === "嘎了" && cardDelayText)}>{failureLabel ?? "---"}</span>}
    </TooltipTrigger>
    <TooltipContent>{queued ? "排队中，点击优先测速" : failureLabel ? <><span className="text-destructive">{failureLabel}</span>，点击重试</> : "点击延迟重新测速"}</TooltipContent>
  </Tooltip>
}
