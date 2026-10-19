import { MobileSheetContent } from "@/components/patterns/mobile-sheet"
import { ResourceListGroup, ResourceListRow, ResourceListSurface } from "@/components/patterns/resource-list"
import { useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  LayoutGrid,
  List,
  MapPinned,
  Zap,
} from "lucide-react";

import type { ProxyAddresses, ProxyNodeSettings } from "@/api/configClient";
import { EmptyState, TableHeader } from "@/components/patterns/page-kit";
import { Button } from "@/components/ui/button";
import { Sheet, SheetTrigger } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Json } from "@/shared/types";

import {
  canSwitchProxyCardProtocol,
  proxyCardDisplayLabel,
  proxyProtocolDisplayName,
  isCurrentProxyCard,
  proxyCardPreferenceKey,
  proxyCardRegion,
  proxyRegionDisplayLabel,
  proxyDelayIdentity,
  type ProxyCardModel,
  type ProxyDelaySample,
  type ProxySortDirection,
  type ProxySortKey,
} from "./proxyLogic";

const PROXY_DESKTOP_GRID = "sm:grid-cols-[28px_minmax(0,1fr)_128px_minmax(80px,132px)_68px]";
const PROXY_GROUP_LABELS: Record<string, string> = { Selector: "手动选择", URLTest: "自动选择", Fallback: "故障转移", LoadBalance: "负载均衡", Relay: "链式代理" };

import { ProxyProtocolPicker } from "./ProxyProtocolPicker";
import { ProxyNodeCard, type ProxyNodeViewProps } from "./ProxyNodeCard";
import { ProxyNodeDetails } from "./ProxyNodeDetails";
import { ProxyDelayButton } from "./ProxyDelayButton";
import { ProxySortMenu } from "./ProxySortMenu";
import type { ProxyDelayPhase } from "./proxyDelayScheduler";

function ProxyNodeRow({ name, card, node, selected, delay, testedAt, testing, queued, failure, testingDisabled, country, countryCode,
  options, identifyingCountries, loading, onSelect, onChoose, onTest, onIdentifyCountries, onRefresh }: ProxyNodeViewProps) {
  const triggerSelection = () => !selected && onSelect()
  const protocol = proxyProtocolDisplayName(options.find(option => option.name === name)?.protocol || String(node.type || "未知"))
  const displayLabel = proxyCardDisplayLabel(card, name)
  return <ResourceListSurface selected={selected} accent="primary">
    <div role="button" tabIndex={0} aria-pressed={selected} aria-label={"选择 " + displayLabel} data-proxy-layout="list" data-proxy-key={card.key}
      onClick={triggerSelection} onKeyDown={event => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); triggerSelection() }
      }}
      className={cn("grid min-h-16 min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_68px] grid-rows-2 items-center gap-x-2 gap-y-1 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent/45 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none focus-visible:ring-inset active:bg-accent/65 sm:grid-rows-1 sm:py-3", PROXY_DESKTOP_GRID)}>
      <ProxyNodeDetails name={name} label={displayLabel} node={node} delay={delay} testedAt={testedAt} failure={failure} country={country} options={options}
        identifyingCountries={identifyingCountries} loading={loading} onIdentifyCountries={onIdentifyCountries} onRefresh={onRefresh}
        className="col-start-2 row-start-1 justify-self-end self-center sm:col-start-1 sm:justify-self-start" />
      <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-2 self-center sm:col-start-2"><span className="truncate text-sm font-medium" title={displayLabel}>{displayLabel}</span></div>
      <div className="col-start-1 row-start-2 flex min-w-0 items-center gap-2 sm:contents">
        {canSwitchProxyCardProtocol(card, options.length) ? <ProxyProtocolPicker name={name} label={displayLabel} protocol={protocol} options={options} onChoose={onChoose} /> :
          <span className="col-start-1 row-start-1 flex min-w-0 items-center gap-1 border border-transparent text-[13px] text-foreground sm:col-start-3 sm:w-full sm:justify-self-stretch sm:px-4"><span aria-hidden="true" className="hidden w-4 shrink-0 sm:block" /><span className="truncate text-left">{protocol}</span></span>}
        <Tooltip><TooltipTrigger render={<span className="col-start-2 row-start-1 min-w-0 truncate text-xs text-muted-foreground sm:col-start-4" />}>
          <span className="sm:hidden">{proxyRegionDisplayLabel(countryCode)}</span><span className="hidden sm:inline">{proxyRegionDisplayLabel(country)}</span>
        </TooltipTrigger><TooltipContent>{proxyRegionDisplayLabel(country)}</TooltipContent></Tooltip>
      </div>
      <ProxyDelayButton name={name} delay={delay} testedAt={testedAt} testing={testing} queued={queued} failure={failure} disabled={testingDisabled} onTest={onTest}
        className="col-start-2 row-start-2 sm:col-start-5 sm:row-start-1" />
    </div>
  </ResourceListSurface>
}
type ProxyGroupListProps = {
  groups: Json[];
  selectedGroup: string | null;
  cardCounts: Record<string, number>;
  loading: boolean;
  onSelect: (groupName: string) => void;
};

export function ProxyGroupList(props: ProxyGroupListProps) {
  return (
    <section className="h-full min-h-0 overflow-hidden rounded-md border bg-background">
      <div className="flex h-10 items-center border-b px-3">
        <h2 className="text-sm font-semibold">代理组</h2>
        <span className="ml-auto text-xs text-muted-foreground">{props.groups.length}</span>
      </div>
      <div className="h-[calc(100%-40px)] overflow-y-auto p-2">
        <ProxyGroupItems {...props} />
      </div>
    </section>
  );
}

function ProxyGroupItems({ groups, selectedGroup, cardCounts, loading, onSelect }: ProxyGroupListProps) {
  return (
    <ResourceListGroup>
      {!groups.length ? (
          <EmptyState>{loading ? <Spinner /> : "没有代理组"}</EmptyState>
        ) : groups.map((group) => {
          const name = String(group.name);
          const selected = name === selectedGroup;
          return (
            <ResourceListRow
              key={name}
              name={name}
              metadata={PROXY_GROUP_LABELS[String(group.type)] ?? String(group.type || "")}
              status={String(cardCounts[name] || 0)}
              selected={selected}
              accent="primary"
              onSelect={() => onSelect(name)}
            />
          );
        })}
    </ResourceListGroup>
  );
}

function ProxyGroupDrawer(props: ProxyGroupListProps) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="ghost" size="lg" className="h-11 min-w-0 max-w-[60%] shrink justify-start px-0 lg:hidden" aria-label={`选择代理组：${props.selectedGroup || "节点"}`} />}>
        <span className="truncate">{props.selectedGroup || "节点"}</span>
        <ChevronDown data-icon="inline-end" />
      </SheetTrigger>
      <MobileSheetContent title="选择代理组" bodyClassName="flex flex-col gap-1">
        <ProxyGroupItems {...props} onSelect={(name) => { props.onSelect(name); setOpen(false) }} />
      </MobileSheetContent>
    </Sheet>
  );
}

export function ProxyNodeList({
  group,
  groups,
  cardCounts,
  onSelectGroup,
  mobileConfigControl,
  sortedCards,
  data,
  providerByNode,
  addresses,
  sortKey,
  sortDirection,
  loading,
  identifyingCountries,
  testingGroups,
  probeStates,
  selectedNode,
  delayFor,
  delaySampleFor,
  onSort,
  onSelect,
  onTestGroup,
  onTestNode,
  onTestCard,
  onIdentifyCountries,
  onRefresh,
  onOpenMergeSettings,
  onOpenNodeInfo,
  nodeInfoAvailable,
  nodeSettings,
}: {
  group: Json | undefined;
  groups: Json[];
  cardCounts: Record<string, number>;
  onSelectGroup: (groupName: string) => void;
  mobileConfigControl: ReactNode;
  sortedCards: ProxyCardModel[];
  data: Record<string, Json>;
  providerByNode: Record<string, string>;
  addresses: ProxyAddresses;
  sortKey: ProxySortKey;
  sortDirection: ProxySortDirection;
  loading: boolean;
  identifyingCountries: boolean;
  testingGroups: Set<string>;
  probeStates: Record<string, ProxyDelayPhase>;
  selectedNode: (card: ProxyCardModel) => string;
  delayFor: (name: string) => number | null;
  delaySampleFor: (name: string) => ProxyDelaySample;
  onSort: (sortKey: ProxySortKey) => void;
  onSelect: (groupName: string, name: string, preferenceKey?: string) => Promise<boolean>;
  onTestGroup: (groupName: string) => void;
  onTestNode: (name: string) => void;
  onTestCard: (card: ProxyCardModel) => void;
  onIdentifyCountries: () => void;
  onRefresh: () => void;
  onOpenMergeSettings: () => void;
  onOpenNodeInfo: () => void;
  nodeInfoAvailable: boolean;
  nodeSettings: ProxyNodeSettings;
}) {
  const groupName = String(group?.name || "");
  const [layout, setLayout] = useState<"list" | "cards">(() => {
    try { return localStorage.getItem("mihomo-proxy-layout") === "cards" ? "cards" : "list"; }
    catch { return "list"; }
  });
  const toggleLayout = () => {
    const next = layout === "list" ? "cards" : "list";
    setLayout(next);
    try { localStorage.setItem("mihomo-proxy-layout", next); }
    catch { /* Layout switching remains available without browser storage. */ }
  };
  const NodeView = layout === "cards" ? ProxyNodeCard : ProxyNodeRow;
  return (
    <section className={cn("flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-md border bg-background", layout === "cards" && "max-lg:border-0")}>
      <div className="flex min-h-10 shrink-0 flex-col gap-2 border-b px-3 py-2 lg:flex-row lg:py-1">
        <div className="flex min-h-11 min-w-0 items-center justify-between gap-3 lg:min-h-8 lg:flex-1">
          <h2 className="hidden text-sm font-semibold lg:block">{group?.name || "节点"}</h2>
          <ProxyGroupDrawer groups={groups} selectedGroup={group ? groupName : null} cardCounts={cardCounts} loading={loading} onSelect={onSelectGroup} />
          {mobileConfigControl}
        </div>
        <div className="grid w-full min-w-0 grid-cols-[2.75rem_repeat(3,minmax(0,1fr))_2.75rem] items-center gap-2 lg:contents">
        <Tooltip><TooltipTrigger render={<Button variant="outline" size="icon-lg" className="lg:ml-auto" aria-label={layout === "list" ? "切换为卡片视图" : "切换为列表视图"} onClick={toggleLayout} />}>
          {layout === "list" ? <LayoutGrid /> : <List />}
        </TooltipTrigger><TooltipContent>{layout === "list" ? "切换为卡片视图" : "切换为列表视图"}</TooltipContent></Tooltip>
        {group && (
          <Button variant="outline" size="lg" className="max-sm:px-1" disabled={identifyingCountries} onClick={onIdentifyCountries}>
            {identifyingCountries ? <Spinner data-icon="inline-start" /> : <MapPinned className="hidden sm:block" data-icon="inline-start" />}
            识别地区
          </Button>
        )}
        {group && (
          <Button variant="outline" size="lg" className="max-sm:px-1" disabled={!nodeInfoAvailable} onClick={onOpenNodeInfo}>
            节点信息
          </Button>
        )}
        {group && (
          <Button variant="outline" size="lg" className="max-sm:px-1" onClick={onOpenMergeSettings}>
            合并设置
          </Button>
        )}
        {group && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-lg"
                  disabled={testingGroups.has(groupName)}
                  onClick={() => onTestGroup(groupName)}
                  aria-label="测试全部节点延迟"
                />
              }
            >
              {testingGroups.has(groupName) ? <Spinner /> : <Zap />}
              <span className="sr-only">测试全部节点延迟</span>
            </TooltipTrigger>
            <TooltipContent>测试全部节点延迟</TooltipContent>
          </Tooltip>
        )}
        </div>
      </div>
      <div className={cn("flex h-11 shrink-0 items-center justify-end gap-2 px-2 lg:px-3", layout === "list" && "sm:hidden")}>
        <ProxySortMenu sortKey={sortKey} direction={sortDirection} onSort={onSort} />
      </div>
      <div data-page-scroll className={cn("min-h-0 flex-1 overflow-x-hidden overflow-y-auto", layout === "cards" && "lg:px-2 lg:pb-2")}>
        <div className={layout === "cards" ? "grid grid-cols-2 content-start gap-3 p-0.5 md:grid-cols-[repeat(auto-fill,minmax(210px,1fr))] md:gap-3.5" : "flex min-w-0 flex-col gap-1 p-2"}>
          {layout === "list" && <TableHeader layoutClassName={cn("hidden text-[11px] sm:grid", PROXY_DESKTOP_GRID)}>
            <span />
            <SortHeader label="名称" active={sortKey === "name"} direction={sortDirection} onClick={() => onSort("name")} />
            <SortHeader label="当前协议" active={sortKey === "protocol"} direction={sortDirection} onClick={() => onSort("protocol")} className="pl-9" />
            <SortHeader label="地区" active={sortKey === "region"} direction={sortDirection} onClick={() => onSort("region")} />
            <SortHeader label="延迟" active={sortKey === "latency"} direction={sortDirection} onClick={() => onSort("latency")} className="justify-end" />
          </TableHeader>}
          {!sortedCards.length ? (
            <EmptyState>{loading ? <Spinner /> : "此代理组没有节点"}</EmptyState>
          ) : sortedCards.map((card) => {
            const name = selectedNode(card);
            const phase = probeStates[proxyDelayIdentity(name, data, providerByNode)];
            const preferenceKey = proxyCardPreferenceKey(card.provider, groupName, card.key);
            const options = card.members.map((member) => ({
              name: member.name,
              protocol: proxyProtocolDisplayName(member.protocol),
              delaySample: delaySampleFor(member.name),
            }));
            return (
              <NodeView
                key={card.key}
                name={name}
                card={card}
                node={data[name] || {}}
                selected={isCurrentProxyCard(card, group?.now)}
                delay={delayFor(name)}
                testedAt={delaySampleFor(name).testedAt}
                testing={Boolean(phase)}
                queued={phase === "queued"}
                failure={delaySampleFor(name).failure}
                testingDisabled={phase === "running"}
                country={proxyCardRegion(name, providerByNode, addresses, nodeSettings)}
                countryCode={proxyCardRegion(name, providerByNode, addresses, nodeSettings, "code")}
                options={options}
                identifyingCountries={identifyingCountries}
                loading={loading}
                onSelect={() => onSelect(
                  groupName,
                  name,
                  card.grouped ? preferenceKey : undefined,
                )}
                onChoose={(next) => onSelect(groupName, next, preferenceKey)}
                onTest={() => card.grouped ? onTestCard(card) : onTestNode(name)}
                onIdentifyCountries={onIdentifyCountries}
                onRefresh={onRefresh}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}

function SortHeader({
  label,
  active,
  direction,
  onClick,
  className,
}: {
  label: string;
  active: boolean;
  direction: ProxySortDirection;
  onClick: () => void;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      className={cn("h-9 justify-start rounded-none px-0 active:translate-y-0", className)}
    >
      {label}
      {active && (
        direction === "asc"
          ? <ArrowUp data-icon="inline-end" />
          : <ArrowDown data-icon="inline-end" />
      )}
    </Button>
  );
}
