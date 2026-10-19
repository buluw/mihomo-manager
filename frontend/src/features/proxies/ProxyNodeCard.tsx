import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { ProxyDelayButton } from "./ProxyDelayButton"
import { ProxyNodeDetails, type ProxyNodeDetailsProps } from "./ProxyNodeDetails"
import { ProxyProtocolPicker } from "./ProxyProtocolPicker"
import { canSwitchProxyCardProtocol, proxyCardDisplayLabel, proxyProtocolDisplayName, proxyRegionDisplayLabel, type ProxyCardModel } from "./proxyLogic"

export type ProxyNodeViewProps = Omit<ProxyNodeDetailsProps, "label"> & {
  card: ProxyCardModel
  selected: boolean
  testing: boolean
  queued: boolean
  testingDisabled: boolean
  countryCode: string | null
  onSelect: () => void
  onChoose: (name: string) => Promise<boolean>
  onTest: () => void
}

export function ProxyNodeCard({ name, card, node, selected, delay, testedAt, testing, queued, failure, testingDisabled, country, countryCode,
  options, identifyingCountries, loading, onSelect, onChoose, onTest, onIdentifyCountries, onRefresh }: ProxyNodeViewProps) {
  const label = proxyCardDisplayLabel(card, name)
  const regionLabel = proxyRegionDisplayLabel(country)
  const region = countryCode && regionLabel.startsWith(countryCode + " · ") ? regionLabel.slice(countryCode.length + 3) : regionLabel
  const protocol = proxyProtocolDisplayName(options.find(option => option.name === name)?.protocol || String(node.type || "未知"))
  return <Card size="sm" data-proxy-layout="card" data-proxy-key={card.key} data-selected={selected}
    className={cn("relative w-full min-w-0 max-w-[280px] gap-2 overflow-hidden rounded-[calc(var(--radius-md)+6px)] border-0 bg-muted py-3 text-foreground shadow-none ring-0 md:gap-2.5 md:py-3.5",
      selected && "bg-accent after:pointer-events-none after:absolute after:inset-y-0 after:left-0 after:w-[3px] after:bg-primary")}>
    <Button variant="ghost" aria-label={"选择 " + label} aria-pressed={selected} onClick={() => { if (!selected) onSelect() }}
      className={cn("absolute inset-0 size-full rounded-[inherit] border-0 bg-transparent p-0 active:translate-y-0",
        selected ? "hover:bg-foreground/2 dark:hover:bg-foreground/2" : "hover:bg-foreground/4 dark:hover:bg-foreground/4")}><span className="sr-only">{label}</span></Button>
    <CardHeader className="pointer-events-none relative min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-1 px-3.5 has-data-[slot=card-action]:grid-cols-[minmax(0,1fr)_auto] md:px-4.5">
      <CardDescription className="col-start-1 row-start-1 flex min-h-8 min-w-0 items-center gap-1.5 text-[11px] leading-4">
        <span className="shrink-0 text-[10px] font-semibold tracking-[0.03em]">{countryCode ?? "--"}</span>
        <span className="truncate" title={region}>{region}</span>
      </CardDescription>
      <CardTitle className="col-span-full col-start-1 row-start-2 flex min-w-0 items-center gap-1.5 text-[15px] leading-[22px] font-semibold md:text-base md:leading-6" title={label}><span className="truncate">{label}</span></CardTitle>
      <CardAction className="pointer-events-auto col-start-2 row-span-1 row-start-1 self-center">
        <ProxyNodeDetails name={name} label={label} node={node} delay={delay} testedAt={testedAt} failure={failure} country={country} options={options}
          identifyingCountries={identifyingCountries} loading={loading} onIdentifyCountries={onIdentifyCountries} onRefresh={onRefresh} cardStyle />
      </CardAction>
    </CardHeader>
    <CardContent className="pointer-events-none relative grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-0.5 px-3.5 md:gap-1.5 md:px-4.5">
      {canSwitchProxyCardProtocol(card, options.length)
        ? <ProxyProtocolPicker name={name} label={label} protocol={protocol} options={options} onChoose={onChoose} variant="card" />
        : <span className="flex h-11 min-w-0 items-center text-[11px] font-medium text-muted-foreground md:text-xs"><span className="truncate">{protocol}</span></span>}
      <ProxyDelayButton name={name} delay={delay} testedAt={testedAt} testing={testing} queued={queued} failure={failure} disabled={testingDisabled} onTest={onTest} cardStyle />
    </CardContent>
  </Card>
}
