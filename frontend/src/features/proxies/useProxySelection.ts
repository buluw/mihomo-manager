import { useCallback, useEffect, useRef, useState } from "react";

import { controllerApi } from "@/api/controllerClient";
import { AbortableRequestPool } from "@/shared/requestLifecycle";
import type { Notify } from "@/shared/types";

import type { ProxySelectionCoordinator } from "./proxySelectionCoordinator";

type ProxySelectionRuntime = {
  applyOptimisticSelection: (groupName: string, name: string) => void;
  applySelection: (groupName: string, name: string) => void;
  currentSelection: (groupName: string) => string;
  refreshRuntime: () => Promise<void>;
};

export function useProxySelection(
  notify: Notify,
  coordinator: ProxySelectionCoordinator,
  runtime: ProxySelectionRuntime,
) {
  const [cardSelections, setCardSelections] = useState<Record<string, string>>({});
  const lifecycle = useRef(0);
  const actions = useRef<AbortableRequestPool | null>(null);
  if (actions.current === null) {
    actions.current = new AbortableRequestPool();
  }

  useEffect(() => {
    const activeActions = actions.current ?? new AbortableRequestPool();
    actions.current = activeActions;
    lifecycle.current += 1;
    return () => {
      lifecycle.current += 1;
      activeActions.dispose();
      if (actions.current === activeActions) actions.current = null;
    };
  }, []);

  const select = useCallback(async (
    groupName: string,
    name: string,
    preferenceKey?: string,
  ) => {
    const activeActions = actions.current;
    if (!activeActions) return false;
    if (coordinator.pendingSelection(groupName) === null) {
      coordinator.synchronize(groupName, runtime.currentSelection(groupName));
    }

    const currentPreference = preferenceKey
      ? localStorage.getItem(preferenceKey)
      : null;
    runtime.applyOptimisticSelection(groupName, name);
    if (preferenceKey) {
      localStorage.setItem(preferenceKey, name);
      setCardSelections((current) => ({ ...current, [preferenceKey]: name }));
    }

    const action = activeActions.begin();
    const activeLifecycle = lifecycle.current;
    const { result } = coordinator.enqueue(
      groupName,
      name,
      () => controllerApi(`/proxies/${encodeURIComponent(groupName)}`, {
        method: "PUT",
        body: JSON.stringify({ name }),
        signal: action.signal,
      }),
      preferenceKey ? { key: preferenceKey, current: currentPreference } : undefined,
    );
    const outcome = await result;
    activeActions.finish(action);
    if (lifecycle.current !== activeLifecycle || action.signal.aborted) return false;

    if (outcome.success) {
      if (!outcome.latest) return false;
      notify(`${groupName} 已切换到 ${name}`);
      void runtime.refreshRuntime();
      return true;
    }
    if (!outcome.latest) return false;

    runtime.applySelection(groupName, outcome.confirmed);
    if (preferenceKey) {
      const confirmedPreference = outcome.confirmedPreference;
      if (confirmedPreference) localStorage.setItem(preferenceKey, confirmedPreference);
      else localStorage.removeItem(preferenceKey);
      setCardSelections((current) => {
        const next = { ...current };
        if (confirmedPreference) next[preferenceKey] = confirmedPreference;
        else delete next[preferenceKey];
        return next;
      });
    }
    notify((outcome.error as Error).message, "error");
    void runtime.refreshRuntime();
    return false;
  }, [coordinator, notify, runtime]);

  const preferenceFor = useCallback(
    (preferenceKey: string) => (
      cardSelections[preferenceKey] ?? localStorage.getItem(preferenceKey)
    ),
    [cardSelections],
  );

  return { select, preferenceFor };
}
