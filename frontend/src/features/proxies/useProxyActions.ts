import { useCallback, useEffect, useRef, useState } from "react";

import { ConfigError, readManagerSettings, refreshProxyCountries, type ProxyAddresses } from "@/api/configClient";
import { readControllerProxyDelay, type ControllerDelayFailure } from "@/api/controllerClient";
import { useAnimatedAction } from "@/hooks/useAnimatedAction";
import { AbortableRequestPool } from "@/shared/requestLifecycle";
import { directDelayTestUrl } from "@/shared/directDelay";
import type { Json, Notify } from "@/shared/types";

import {
  proxyDelayTarget,
  isDirectProxy,
  DIRECT_DELAY_TEST_URL,
  proxyDelayIdentity,
  proxyDelayFailure,
  uniqueProxyDelayTargets,
  proxyNodeDelayRequest,
  measurableProxyCardMembers,
  runProxyCardDelayTests,
  type ProxyCardModel,
  type ProxyDelaySample,
} from "./proxyLogic";
import { ProxyDelayScheduler, type ProxyDelayPhase, type ProxyDelayPriority } from "./proxyDelayScheduler";

type ProxyActionRuntime = {
  addresses: ProxyAddresses;
  refreshRuntime: () => Promise<void>;
  replaceAddresses: (addresses: ProxyAddresses) => boolean;
};

export function useProxyActions(
  notify: Notify,
  data: Record<string, Json>,
  providerByNode: Record<string, string>,
  runtime: ProxyActionRuntime,
) {
  const [delays, setDelays] = useState<Record<string, ProxyDelaySample>>({});
  const [testingGroups, setTestingGroups] = useState<Set<string>>(new Set());
  const [probeStates, setProbeStates] = useState<Record<string, ProxyDelayPhase>>({});
  const scheduler = useRef<ProxyDelayScheduler | null>(null);
  const testingGroupsRef = useRef(new Set<string>());
  const lastDirectDelayUrl = useRef<string | null>(null);
  const lifecycle = useRef(0);
  const actions = useRef<AbortableRequestPool | null>(null);
  if (actions.current === null) {
    actions.current = new AbortableRequestPool();
  }
  const { busy: identifyingCountries, run: runCountryLookup } = useAnimatedAction();

  useEffect(() => {
    const activeActions = actions.current ?? new AbortableRequestPool();
    actions.current = activeActions;
    const activeScheduler = new ProxyDelayScheduler(states => {
      if (scheduler.current === activeScheduler) setProbeStates(states);
    });
    scheduler.current = activeScheduler;
    setProbeStates({});
    lifecycle.current += 1;
    return () => {
      lifecycle.current += 1;
      scheduler.current = null;
      activeScheduler.dispose();
      activeActions.dispose();
      if (actions.current === activeActions) actions.current = null;
    };
  }, []);

  const identifyCountries = useCallback(async () => {
    if (!runtime.addresses.source) {
      notify("节点来源无法确认，请刷新或选择配置并成功加载后重试", "error");
      return;
    }
    const activeActions = actions.current;
    if (!activeActions) return;
    const action = activeActions.begin();
    const activeLifecycle = lifecycle.current;
    try {
      await runCountryLookup(async () => {
        const result = await refreshProxyCountries(action.signal, runtime.addresses.source?.loadVersion);
        if (action.signal.aborted || lifecycle.current !== activeLifecycle) return;
        if (!runtime.replaceAddresses(result.addresses)) {
          notify("节点来源已变化，本次识别结果未用于当前列表，请重新识别", "error");
          return;
        }
        if (result.recognized === 0) {
          notify(result.failed ? `地区查询未成功，${result.failed} 个地址无法解析或外部查询失败` : "所选来源没有可用的节点地址，未执行地区识别", "error");
        } else notify(`已识别 ${result.recognized} 个地址的地区${result.failed ? `，${result.failed} 个未识别` : ""}`);
      });
    } catch (error) {
      if (!action.signal.aborted && lifecycle.current === activeLifecycle) {
        notify(error instanceof ConfigError && error.code === "proxy_address_source_unavailable"
          ? "节点来源已变化或无法确认，请刷新后重新识别"
          : (error as Error).message, "error");
      }
    } finally {
      activeActions.finish(action);
    }
  }, [notify, runCountryLookup, runtime]);

  const measure = useCallback((name: string, priority: ProxyDelayPriority) => {
    const target = proxyDelayTarget(name, data);
    const identity = proxyDelayIdentity(name, data, providerByNode);
    const activeScheduler = scheduler.current;
    const activeLifecycle = lifecycle.current;
    if (!activeScheduler) return Promise.reject(new DOMException("测速会话已关闭", "AbortError"));
    return activeScheduler.request(identity, priority, async signal => {
      let delay: number | null = null;
      let failure: ControllerDelayFailure | undefined;
      try {
        let directUrl: string | undefined;
        if (isDirectProxy(data[target])) {
          try {
            directUrl = directDelayTestUrl((await readManagerSettings(signal)).directDelayTest);
            lastDirectDelayUrl.current = directUrl;
          } catch (error) {
            if (signal.aborted) throw error;
            directUrl = lastDirectDelayUrl.current ?? DIRECT_DELAY_TEST_URL;
          }
        }
        delay = await readControllerProxyDelay(proxyNodeDelayRequest(target, providerByNode[target], data[target], directUrl), signal);
        return delay;
      } catch (error) {
        if (!signal.aborted) failure = proxyDelayFailure(error);
        throw error;
      } finally {
        if (!signal.aborted && lifecycle.current === activeLifecycle) {
          setDelays(current => ({ ...current, [target]: { delay, testedAt: Date.now(), ...(failure ? { failure } : {}) } }));
        }
      }
    });
  }, [data, providerByNode]);

  const testNode = useCallback(async (name: string) => {
    try { await measure(name, "manual"); }
    catch { /* measure publishes the result; the scheduler settles cancellation. */ }
  }, [measure]);

  const testCard = useCallback(async (card: ProxyCardModel) => {
    if (!card.grouped) return;
    const members = measurableProxyCardMembers(card, data, providerByNode);
    if (!members.length) return;
    await runProxyCardDelayTests(members, ({ name }) => measure(name, "manual"));
  }, [data, measure, providerByNode]);

  const testGroup = useCallback(async (groupName: string) => {
    if (testingGroupsRef.current.has(groupName)) return;
    const activeLifecycle = lifecycle.current;
    testingGroupsRef.current = new Set(testingGroupsRef.current).add(groupName);
    setTestingGroups(testingGroupsRef.current);
    try {
      const members = uniqueProxyDelayTargets(((data[groupName]?.all || []) as unknown[]).map(String), data, providerByNode);
      await runProxyCardDelayTests(members, ({ name }) => measure(name, "batch"));
    } finally {
      if (lifecycle.current === activeLifecycle) {
        const next = new Set(testingGroupsRef.current); next.delete(groupName); testingGroupsRef.current = next;
        setTestingGroups(next);
      }
    }
  }, [data, measure, providerByNode]);

  return {
    delays,
    testingGroups,
    probeStates,
    identifyingCountries,
    identifyCountries,
    testNode,
    testCard,
    testGroup,
  };
}
