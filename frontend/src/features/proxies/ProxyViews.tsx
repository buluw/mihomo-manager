import { MobileSheetContent } from "@/components/patterns/mobile-sheet"
import { MobileChoiceRow } from "@/components/patterns/mobile-choice-sheet"
import { useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Eye,
  MapPinned,
  Network,
  RefreshCw,
  Zap,
} from "lucide-react";

import type { ProxyAddresses, ProxyNodeSettings } from "@/api/configClient";
import { EmptyState, StatusDot, TableHeader } from "@/components/patterns/page-kit";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetTrigger } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Json } from "@/shared/types";

import {
  canSwitchProxyCardProtocol,
  proxyCardDisplayLabel,
  proxyProtocolOptionColumns,
  proxyCardPreferenceKey,
  proxyCardRegion,
  proxyRegionDisplayLabel,
  proxyDelayTarget,
  type ProxyCardModel,
  type ProxyDelaySample,
  type ProxySortDirection,
  type ProxySortKey,
} from "./proxyLogic";

const PROXY_DESKTOP_GRID = "sm:grid-cols-[28px_minmax(0,1fr)_128px_minmax(80px,132px)_68px_44px]";

function delayTone(delay: number | null) {
  if (!delay || delay > 800) return "error" as const;
  if (delay >= 300) return "warn" as const;
  return "ok" as const;
}

function delayClass(delay: number | null) {
  if (!delay || delay > 800) return "text-destructive";
  if (delay >= 300) return "text-status-warning";
  return "text-status-success";
}

import { ProxyProtocolPicker, type ProxyProtocolOption } from "./ProxyProtocolPicker";

function NodeDetails({
  name,
  label,
  node,
  delay,
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
  country: string | null;
  options: ProxyProtocolOption[];
  identifyingCountries: boolean;
  loading: boolean;
  onIdentifyCountries: () => void;
  onRefresh: () => void;
}) {
  const protocol = options.find((option) => option.name === name)?.protocol
    || String(node.type || "未知");
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
          <dd className="ml-auto font-mono text-xs">{delay ? `${delay} ms` : "---"}</dd>
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
            <span className="ml-2 leading-tight">{option.protocol}</span>
            <span className="ml-auto font-mono text-xs text-muted-foreground">
              {proxyProtocolOptionColumns(option.name, option.protocol, option.delaySample).delayLabel}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProxyNodeRow({
  name,
  card,
  node,
  selected,
  delay,
  testing,
  testingDisabled,
  country,
  countryCode,
  options,
  identifyingCountries,
  loading,
  onSelect,
  onChoose,
  onTest,
  onIdentifyCountries,
  onRefresh,
}: {
  name: string;
  card: ProxyCardModel;
  node: Json;
  selected: boolean;
  delay: number | null;
  testing: boolean;
  testingDisabled: boolean;
  country: string | null;
  countryCode: string | null;
  options: ProxyProtocolOption[];
  identifyingCountries: boolean;
  loading: boolean;
  onSelect: () => void;
  onChoose: (name: string) => Promise<boolean>;
  onTest: () => void;
  onIdentifyCountries: () => void;
  onRefresh: () => void;
}) {
  const triggerSelection = () => !selected && onSelect();
  const protocol = options.find((option) => option.name === name)?.protocol
    || String(node.type || "未知");
  const displayLabel = proxyCardDisplayLabel(card, name);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={triggerSelection}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          triggerSelection();
        }
      }}
      className={cn(
        "relative grid min-h-[72px] min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)] items-center gap-x-3 border-b px-3 py-1 text-[13px] transition-colors last:border-b-0 hover:bg-accent/45 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none focus-visible:ring-inset active:bg-accent/65 sm:h-11 sm:min-h-11 sm:grid-rows-1 sm:gap-2 sm:py-0",
        PROXY_DESKTOP_GRID,
        selected && "bg-mode-rule/10 text-mode-rule before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-mode-rule hover:bg-mode-rule/15",
      )}
    >
      <div className="col-start-1 row-start-1 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center sm:contents">
        <Dialog>
          <DialogTrigger
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            render={
              <Button
                variant="ghost"
                size="icon"
                className="col-start-2 row-start-1 size-11 justify-self-end self-center sm:col-start-1 sm:size-7 sm:justify-self-start"
                aria-label={`查看 ${displayLabel} 详情`}
              />
            }
          >
            <Eye />
            <span className="sr-only">查看 {displayLabel} 详情</span>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{displayLabel}</DialogTitle>
              <DialogDescription>
                {proxyRegionDisplayLabel(country)} · {options.length} 个成员协议
              </DialogDescription>
            </DialogHeader>
            <NodeDetails
              name={name}
              label={displayLabel}
              node={node}
              delay={delay}
              country={country}
              options={options}
              identifyingCountries={identifyingCountries}
              loading={loading}
              onIdentifyCountries={onIdentifyCountries}
              onRefresh={onRefresh}
            />
          </DialogContent>
        </Dialog>
        <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-2 self-center sm:col-start-2">
          <span className="min-w-0 py-1 text-sm leading-5 font-medium wrap-anywhere sm:truncate sm:py-0 sm:text-[13px]">{displayLabel}</span>
        </div>
      </div>
      <div className="col-start-1 row-start-2 grid min-w-0 grid-cols-[minmax(0,max-content)_minmax(0,1fr)_auto_44px] items-center gap-x-1 sm:contents">
        {canSwitchProxyCardProtocol(card, options.length) ? <ProxyProtocolPicker name={name} label={displayLabel} protocol={protocol} options={options} onChoose={onChoose} /> : (
          <span className="col-start-1 row-start-1 flex min-w-0 items-center gap-1 border border-transparent text-[13px] text-foreground sm:col-start-3 sm:w-full sm:justify-self-stretch sm:px-4">
            <span aria-hidden="true" className="hidden w-4 shrink-0 sm:block" />
            <span className="truncate text-left">{protocol}</span>
          </span>
        )}
        <Tooltip>
          <TooltipTrigger
            render={<span className="col-start-2 row-start-1 min-w-0 truncate text-xs text-muted-foreground sm:col-start-4" />}
          >
            <span className="sm:hidden">{proxyRegionDisplayLabel(countryCode)}</span>
            <span className="hidden sm:inline">{proxyRegionDisplayLabel(country)}</span>
          </TooltipTrigger>
          <TooltipContent>{proxyRegionDisplayLabel(country)}</TooltipContent>
        </Tooltip>
        <span className={cn(
          "col-start-3 row-start-1 shrink-0 font-mono text-xs tabular-nums sm:col-start-5 sm:text-right",
          delayClass(delay),
        )}
        >
          {delay ? `${delay} ms` : "---"}
        </span>
        <Tooltip>
          <TooltipTrigger
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            render={
              <Button
                variant="ghost"
                size="icon-lg"
                className="col-start-4 row-start-1 size-11 justify-self-end sm:col-start-6 sm:size-8"
                disabled={testingDisabled}
                onClick={(event) => {
                  event.stopPropagation();
                  onTest();
                }}
                aria-label={`测试 ${name} 延迟`}
              />
            }
          >
            {testing ? <Spinner /> : <Zap />}
            <span className="sr-only">测试此节点延迟</span>
          </TooltipTrigger>
          <TooltipContent>测试此节点延迟</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
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
      <div className="h-[calc(100%-40px)] overflow-y-auto">
        <ProxyGroupItems {...props} />
      </div>
    </section>
  );
}

function ProxyGroupItems({ groups, selectedGroup, cardCounts, loading, onSelect }: ProxyGroupListProps) {
  return (
    <>
      {!groups.length ? (
          <EmptyState>{loading ? <Spinner /> : "没有代理组"}</EmptyState>
        ) : groups.map((group) => {
          const name = String(group.name);
          const selected = name === selectedGroup;
          return (
            <Button
              key={name}
              type="button"
              variant="ghost"
              size="lg"
              aria-pressed={selected}
              onClick={() => onSelect(name)}
              className={cn(
                "relative h-11 w-full justify-start rounded-none border-x-0 border-t-0 border-b border-border px-3 text-left text-[13px] hover:bg-accent/55 active:translate-y-0 active:bg-accent/70 last:border-b-0 lg:h-10",
                selected && "bg-mode-rule/10 font-medium text-mode-rule before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-mode-rule hover:bg-mode-rule/15",
              )}
            >
              <Network
                data-icon="inline-start"
                className={cn("text-muted-foreground", selected && "text-mode-rule")}
              />
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <span className="text-xs text-muted-foreground">{cardCounts[name] || 0}</span>
            </Button>
          );
        })}
    </>
  );
}

function ProxyGroupDrawer(props: ProxyGroupListProps) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="ghost" size="lg" className="h-11 min-w-0 max-w-full shrink px-0 lg:hidden" aria-label={`选择代理组：${props.selectedGroup || "节点"}`} />}>
        <span className="truncate">{props.selectedGroup || "节点"}</span>
        <ChevronDown data-icon="inline-end" />
      </SheetTrigger>
      <MobileSheetContent title="选择代理组" bodyClassName="flex flex-col gap-1">
        {!props.groups.length ? <EmptyState>{props.loading ? <Spinner /> : "没有代理组"}</EmptyState> : props.groups.map(group => {
          const name = String(group.name);
          return <MobileChoiceRow key={name} label={name} description={String(props.cardCounts[name] || 0)} selected={name === props.selectedGroup} onChoose={() => { props.onSelect(name); setOpen(false) }} />;
        })}
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
  testingNodes,
  testingCards,
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
  testingNodes: Set<string>;
  testingCards: Set<string>;
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
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-md border bg-background">
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1">
        <div className="flex min-w-0 basis-full items-center gap-2 md:basis-auto md:flex-1">
          <h2 className="hidden text-sm font-semibold lg:block">{group?.name || "节点"}</h2>
          <ProxyGroupDrawer groups={groups} selectedGroup={group ? groupName : null} cardCounts={cardCounts} loading={loading} onSelect={onSelectGroup} />
          {mobileConfigControl}
        </div>
        <div className="grid w-full min-w-0 grid-cols-[auto_repeat(2,minmax(0,1fr))_2.75rem] gap-2 md:contents">
        {group && (
          <Button variant="outline" size="sm" className="md:ml-auto" disabled={identifyingCountries} onClick={onIdentifyCountries}>
            {identifyingCountries ? <Spinner data-icon="inline-start" /> : <MapPinned data-icon="inline-start" />}
            识别地区
          </Button>
        )}
        {group && (
          <Button variant="outline" size="sm" disabled={!nodeInfoAvailable} onClick={onOpenNodeInfo}>
            节点信息
          </Button>
        )}
        {group && (
          <Button variant="outline" size="sm" onClick={onOpenMergeSettings}>
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
                  className="size-9 [&_svg]:size-5"
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
      <div data-page-scroll className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="min-w-0">
          <TableHeader layoutClassName={cn("hidden text-[11px] sm:grid", PROXY_DESKTOP_GRID)}>
            <span />
            <SortHeader label="名称" active={sortKey === "name"} direction={sortDirection} onClick={() => onSort("name")} />
            <SortHeader label="当前协议" active={sortKey === "protocol"} direction={sortDirection} onClick={() => onSort("protocol")} className="pl-9" />
            <SortHeader label="地区" active={sortKey === "region"} direction={sortDirection} onClick={() => onSort("region")} />
            <SortHeader label="延迟" active={sortKey === "latency"} direction={sortDirection} onClick={() => onSort("latency")} className="justify-end" />
            <span className="text-center">测速</span>
          </TableHeader>
          {!sortedCards.length ? (
            <EmptyState>{loading ? <Spinner /> : "此代理组没有节点"}</EmptyState>
          ) : sortedCards.map((card) => {
            const name = selectedNode(card);
            const preferenceKey = proxyCardPreferenceKey(card.provider, groupName, card.key);
            const options = card.members.map((member) => ({
              name: member.name,
              protocol: member.protocol,
              delaySample: delaySampleFor(member.name),
            }));
            return (
              <ProxyNodeRow
                key={card.key}
                name={name}
                card={card}
                node={data[name] || {}}
                selected={card.members.some((member) => member.name === group?.now)}
                delay={delayFor(name)}
                testing={testingCards.has(card.key) || card.members.some(member => testingNodes.has(proxyDelayTarget(member.name, data)))}
                testingDisabled={testingCards.has(card.key) || card.members.every(member => testingNodes.has(proxyDelayTarget(member.name, data)))}
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
