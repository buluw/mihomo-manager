import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Notify } from "@/shared/types";

import { ProxyMobileSplit } from "./ProxyMobileSplit";
import { ProxyConfigDrawer } from "./ProxyConfigDrawer";
import { ProxyMergeSettingsDialog } from "./ProxyMergeSettingsDialog";
import { ProxyNodeInfoDialog } from "./ProxyNodeInfoDialog";
import { ProxyGroupList, ProxyNodeList } from "./ProxyViews";
import {
  buildProxyCards,
  displayedProxyDelay,
  displayedProxyDelaySample,
  listProxyGroups,
  proxyCardPreferenceKey,
  proxyNodeInfoTarget,
  selectedProxyCardNode,
  sortProxyCards,
  type ProxyCardModel,
  type ProxySortDirection,
  type ProxySortKey,
} from "./proxyLogic";
import { availableProxyNodes } from "./proxyMergeSettings";
import { proxyIdentityKey } from "./proxyMergeSettings";
import { ProxySelectionCoordinator } from "./proxySelectionCoordinator";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useProxyActions } from "./useProxyActions";
import { useProxyRuntime } from "./useProxyRuntime";
import { useProxyMergeSettings } from "./useProxyMergeSettings";
import { useProxyNodeInfo } from "./useProxyNodeInfo";
import { useProxySelection } from "./useProxySelection";
import { useProxyConfigSwitcher } from "./useProxyConfigSwitcher";

export function Proxies({ notify }: { notify: Notify }) {
  const selectionCoordinator = useRef(new ProxySelectionCoordinator()).current;
  const runtime = useProxyRuntime(notify, selectionCoordinator);
  const selection = useProxySelection(notify, selectionCoordinator, runtime);
  const mergeSettings = useProxyMergeSettings();
  const actions = useProxyActions(
    notify,
    runtime.data,
    runtime.providerByNode,
    runtime,
  );
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<ProxySortKey>("name");
  const [sortDirection, setSortDirection] = useState<ProxySortDirection>("asc");

  const groups = useMemo(() => listProxyGroups(runtime.data, runtime.groupOrder), [runtime.data, runtime.groupOrder]);
  const availableNodes = useMemo(
    () => availableProxyNodes(runtime.data, runtime.providerByNode),
    [runtime.data, runtime.providerByNode],
  );
  const group = groups.find((item) => item.name === selectedGroup) || groups[0];
  const currentNode = useMemo(() => proxyNodeInfoTarget(
    runtime.data,
    String(group?.name || ""),
    runtime.providerByNode,
    availableNodes,
    runtime.ambiguousProviderNodes,
  ), [availableNodes, group?.name, runtime.ambiguousProviderNodes, runtime.data, runtime.providerByNode]);
  const nodeInfo = useProxyNodeInfo(availableNodes, runtime.addresses, runtime.refreshAddresses);
  const configSwitcher = useProxyConfigSwitcher(notify, runtime.load);

  useEffect(() => {
    if (!groups.length) setSelectedGroup(null);
    else if (
      !selectedGroup
      || !groups.some((group) => group.name === selectedGroup)
    ) {
      setSelectedGroup(String(groups[0].name));
    }
  }, [groups, selectedGroup]);

  const delayFor = useCallback(
    (name: string) => displayedProxyDelay(runtime.data[name], actions.delays[name]),
    [actions.delays, runtime.data],
  );
  const delaySampleFor = useCallback(
    (name: string) => displayedProxyDelaySample(runtime.data[name], actions.delays[name]),
    [actions.delays, runtime.data],
  );
  const cards = useMemo(
    () => (
      group
        ? buildProxyCards(
          [...(group.all || [])],
          runtime.data,
          runtime.providerByNode,
          runtime.addresses,
          mergeSettings.settings,
        )
        : []
    ),
    [group, mergeSettings.settings, runtime.addresses, runtime.data, runtime.providerByNode],
  );
  const cardSelection = useCallback((card: ProxyCardModel) => {
    if (!group) return card.members[0]?.name || "";
    const preferenceKey = proxyCardPreferenceKey(
      card.provider,
      String(group.name),
      card.key,
    );
    return selectedProxyCardNode(
      card,
      String(group.now || ""),
      selection.preferenceFor(preferenceKey),
    );
  }, [group, selection]);
  const sortedCards = useMemo(
    () => sortProxyCards(
      cards,
      sortKey,
      sortDirection,
      cardSelection,
      runtime.data,
      runtime.providerByNode,
      runtime.addresses,
      nodeInfo.settings,
      actions.delays,
    ),
    [
      actions.delays,
      cardSelection,
      cards,
      runtime.addresses,
      runtime.data,
      runtime.providerByNode,
      nodeInfo.settings,
      sortDirection,
      sortKey,
    ],
  );
  const groupCardCounts = useMemo(
    () => Object.fromEntries(groups.map((item) => [
      String(item.name),
      buildProxyCards(
        [...(item.all || [])],
        runtime.data,
        runtime.providerByNode,
        runtime.addresses,
        mergeSettings.settings,
      ).length,
    ])),
    [groups, mergeSettings.settings, runtime.addresses, runtime.data, runtime.providerByNode],
  );
  const changeSort = (nextKey: ProxySortKey) => {
    if (sortKey === nextKey) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
    } else {
      setSortKey(nextKey);
      setSortDirection("asc");
    }
  };
  const openNodeInfo = useCallback(() => {
    if (currentNode) nodeInfo.openForIdentity(proxyIdentityKey(currentNode));
  }, [currentNode, nodeInfo]);

  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)] gap-3 p-4 md:grid-rows-[auto_minmax(0,1fr)]">
      <div className="hidden min-w-0 flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2 md:flex">
        <span className="text-xs font-medium text-muted-foreground">运行配置</span>
        <Select value={configSwitcher.target || null} onValueChange={(value) => value && configSwitcher.setTarget(String(value))} disabled={configSwitcher.busy}>
          <SelectTrigger aria-label="运行配置" className="min-w-0 max-w-72 flex-1"><SelectValue placeholder={configSwitcher.listLoading ? "正在读取配置列表" : "选择配置"} /></SelectTrigger>
          <SelectContent side="bottom" align="start" alignItemWithTrigger={false} collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}>
            <SelectGroup>{configSwitcher.files.map((file) => <SelectItem key={file.name} value={file.name}>{file.name}{file.name === configSwitcher.loaded ? "（当前）" : ""}</SelectItem>)}</SelectGroup>
          </SelectContent>
        </Select>
        <Button size="sm" disabled={!configSwitcher.target || configSwitcher.busy} onClick={() => void configSwitcher.apply()}>{configSwitcher.busy && <Spinner data-icon="inline-start" />}{configSwitcher.actionLabel}</Button>
        {configSwitcher.listLoading && configSwitcher.files.length > 0 && <span role="status" className="text-xs text-muted-foreground">正在刷新配置列表</span>}
        {configSwitcher.listMessage && configSwitcher.files.length > 0 && <span role="status" className="text-xs text-muted-foreground">{configSwitcher.listMessage}</span>}
      </div>
      <div className="min-h-0">
        <ProxyMobileSplit
          groups={
            <ProxyGroupList
              groups={groups}
              selectedGroup={group ? String(group.name) : null}
              cardCounts={groupCardCounts}
              loading={runtime.loading}
              onSelect={setSelectedGroup}
            />
          }
          nodes={
            <ProxyNodeList
              group={group}
              groups={groups}
              cardCounts={groupCardCounts}
              onSelectGroup={setSelectedGroup}
              mobileConfigControl={<ProxyConfigDrawer switcher={configSwitcher} />}
              sortedCards={sortedCards}
              data={runtime.data}
              providerByNode={runtime.providerByNode}
              addresses={runtime.addresses}
              sortKey={sortKey}
              sortDirection={sortDirection}
              loading={runtime.loading}
              identifyingCountries={actions.identifyingCountries}
              testingGroups={actions.testingGroups}
              testingNodes={actions.testingNodes}
              testingCards={actions.testingCards}
              selectedNode={cardSelection}
              delayFor={delayFor}
              delaySampleFor={delaySampleFor}
              onSort={changeSort}
              onSelect={selection.select}
              onTestGroup={(groupName) => void actions.testGroup(groupName)}
              onTestNode={(name) => void actions.testNode(name)}
              onTestCard={(card) => void actions.testCard(card)}
              onIdentifyCountries={() => void actions.identifyCountries()}
              onRefresh={() => void runtime.load()}
              onOpenMergeSettings={() => mergeSettings.changeOpen(true)}
              onOpenNodeInfo={openNodeInfo}
              nodeInfoAvailable={Boolean(currentNode)}
              nodeSettings={nodeInfo.settings}
            />
          }
        />
      </div>
      <ProxyMergeSettingsDialog
        open={mergeSettings.open}
        onOpenChange={mergeSettings.changeOpen}
        draft={mergeSettings.draft}
        onDraftChange={mergeSettings.setDraft}
        available={availableNodes}
        nodesState={runtime.nodesState}
        addresses={runtime.addresses}
        readAddresses={runtime.refreshAddresses}
        loading={mergeSettings.loading || runtime.loading}
        saving={mergeSettings.saving}
        sessionLoaded={mergeSettings.sessionLoaded}
        error={mergeSettings.error}
        onSave={() => void mergeSettings.save()}
      />
      <ProxyNodeInfoDialog workspace={nodeInfo} />
    </div>
  );
}
