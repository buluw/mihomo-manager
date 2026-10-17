import { useCallback, useEffect, useRef, useState } from "react";

import type { ProxyAddresses } from "@/api/configClient";
import { useRegisterPageRefresh } from "@/app/pageRefresh";
import { withMinimumSpin } from "@/hooks/useAnimatedAction";
import type { Json, Notify } from "@/shared/types";

import {
  applyPendingProxySelections,
  mergeProxyProviderNodes,
  setProxyGroupSelection,
} from "./proxyLogic";
import {
  ProxyRequestController,
  readOptionalProxyAddresses,
  readOptionalProxyGroupOrder,
  readProxyRuntimeSnapshot,
  type ProxyGroupOrder,
} from "./proxyRuntime";
import type { ProxySelectionCoordinator } from "./proxySelectionCoordinator";

const EMPTY_ADDRESSES: ProxyAddresses = {
  inline: {},
  providers: {},
  groups: {},
  countries: {},
};

type CachedProxyRuntime = {
  data: Record<string, Json>;
  providerByNode: Record<string, string>;
  ambiguousProviderNodes: Set<string>;
};

let cachedRuntime: CachedProxyRuntime | null = null;
let cachedGroupOrder: ProxyGroupOrder | null = null;

export function useProxyRuntime(
  notify: Notify,
  selectionCoordinator: ProxySelectionCoordinator,
) {
  const [data, setData] = useState<Record<string, Json>>(() => cachedRuntime?.data || {});
  const [providerByNode, setProviderByNode] = useState<Record<string, string>>(
    () => cachedRuntime?.providerByNode || {},
  );
  const [ambiguousProviderNodes, setAmbiguousProviderNodes] = useState<Set<string>>(
    () => cachedRuntime?.ambiguousProviderNodes || new Set(),
  );
  const [addresses, setAddresses] = useState<ProxyAddresses>(EMPTY_ADDRESSES);
  const addressesRef = useRef(addresses);
  addressesRef.current = addresses;
  const [loading, setLoading] = useState(false);
  const [nodesState, setNodesState] = useState<"loading" | "ready" | "error">("loading");
  const lastNodesState = useRef<"ready" | "error">("error");
  const dataRef = useRef<Record<string, Json>>(cachedRuntime?.data || {});
  const requests = useRef(new ProxyRequestController());
  const [groupOrder, setGroupOrder] = useState<string[]>(() => cachedGroupOrder?.names || []);

  const refreshGroupOrder = useCallback(async () => {
    const request = requests.current.beginGroupOrder();
    try {
      const next = await readOptionalProxyGroupOrder(request.signal, cachedGroupOrder);
      if (!request.isCurrent()) return;
      cachedGroupOrder = next;
      setGroupOrder(next?.names || []);
    } finally { request.finish(); }
  }, []);

  const publishRuntime = useCallback((
    proxyMap: Record<string, Json>,
    providers: Record<string, Json>,
  ) => {
    const merged = mergeProxyProviderNodes(proxyMap, providers);
    Object.values(merged.proxies).forEach((proxy) => {
      if (!Array.isArray(proxy.all)) return;
      const groupName = String(proxy.name || "");
      if (!groupName || selectionCoordinator.pendingSelection(groupName) !== null) return;
      selectionCoordinator.synchronize(groupName, String(proxy.now || ""));
    });
    const proxies = applyPendingProxySelections(
      merged.proxies,
      selectionCoordinator.pendingSelections(),
    );
    dataRef.current = proxies;
    cachedRuntime = { data: proxies, providerByNode: merged.providerByNode, ambiguousProviderNodes: merged.ambiguousProviderNodes };
    setData(proxies);
    setProviderByNode(merged.providerByNode);
    setAmbiguousProviderNodes(merged.ambiguousProviderNodes);
    lastNodesState.current = "ready";
    setNodesState("ready");
  }, [selectionCoordinator]);

  const refreshAddresses = useCallback(async () => {
    const request = requests.current.beginAddresses();
    try {
      const nextAddresses = await readOptionalProxyAddresses(request.signal);
      if (!request.isCurrent()) return null;
      addressesRef.current = nextAddresses ?? EMPTY_ADDRESSES;
      setAddresses(addressesRef.current);
      return nextAddresses;
    } finally { request.finish(); }
  }, []);

  const load = useCallback(async () => {
    const runtimeRequest = requests.current.beginRuntime();
    if (!runtimeRequest.isCurrent()) return;

    setLoading(true);
    setNodesState("loading");
    addressesRef.current = EMPTY_ADDRESSES;
    setAddresses(EMPTY_ADDRESSES);
    refreshAddresses();
    void refreshGroupOrder();

    try {
      const snapshot = await withMinimumSpin(
        readProxyRuntimeSnapshot(runtimeRequest.signal),
      );
      if (runtimeRequest.isCurrent()) {
        publishRuntime(snapshot.proxies, snapshot.providers);
      }
    } catch (error) {
      if (runtimeRequest.isCurrent()) {
        lastNodesState.current = "error";
        setNodesState("error");
        notify((error as Error).message, "error");
      }
    } finally {
      if (runtimeRequest.finish()) setLoading(false);
    }
  }, [notify, publishRuntime, refreshAddresses, refreshGroupOrder]);

  const refreshRuntime = useCallback(async () => {
    const request = requests.current.beginRuntime();
    if (!request.isCurrent()) return;
    setLoading(false);
    setNodesState((current) => current === "ready" ? current : "loading");
    void refreshAddresses();
    void refreshGroupOrder();
    try {
      const snapshot = await readProxyRuntimeSnapshot(request.signal);
      if (request.isCurrent()) publishRuntime(snapshot.proxies, snapshot.providers);
    } catch {
      // Global Controller status owns passive refresh errors.
      if (request.isCurrent()) {
        lastNodesState.current = "error";
        setNodesState("error");
      }
    } finally {
      request.finish();
    }
  }, [publishRuntime, refreshAddresses, refreshGroupOrder]);

  useRegisterPageRefresh(load);

  useEffect(() => {
    const activeRequests = new ProxyRequestController();
    requests.current = activeRequests;
    if (cachedRuntime) {
      void refreshRuntime();
      refreshAddresses();
    } else {
      void load();
    }

    const timer = window.setInterval(
      () => !document.hidden && void refreshRuntime(),
      30_000,
    );
    const refreshVisible = () => !document.hidden && void refreshRuntime();
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
      activeRequests.dispose();
    };
  }, [load, refreshAddresses, refreshRuntime]);

  const applySelection = useCallback((groupName: string, name: string) => {
    const optimistic = setProxyGroupSelection(dataRef.current, groupName, name);
    dataRef.current = optimistic;
    if (cachedRuntime) cachedRuntime = { ...cachedRuntime, data: optimistic };
    setData(optimistic);
  }, []);

  const applyOptimisticSelection = useCallback((groupName: string, name: string) => {
    requests.current.cancelRuntime();
    setLoading(false);
    setNodesState(lastNodesState.current);
    applySelection(groupName, name);
  }, [applySelection]);

  const currentSelection = useCallback(
    (groupName: string) => String(dataRef.current[groupName]?.now || ""),
    [],
  );

  return {
    data,
    groupOrder,
    providerByNode,
    ambiguousProviderNodes,
    addresses,
    loading,
    nodesState,
    load,
    refreshRuntime,
    refreshAddresses,
    applyOptimisticSelection,
    applySelection,
    currentSelection,
    replaceAddresses: (nextAddresses: ProxyAddresses) => {
      if (nextAddresses.source?.loadVersion !== addressesRef.current.source?.loadVersion) return false;
      addressesRef.current = nextAddresses;
      setAddresses(nextAddresses);
      return true;
    },
  };
}
