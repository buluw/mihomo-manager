import { useCallback, useEffect, useRef, useState } from "react";

import { ConfigError, readManagerSettings, refreshProxyCountries, type ProxyAddresses } from "@/api/configClient";
import { controllerApi } from "@/api/controllerClient";
import { useAnimatedAction, withMinimumSpin } from "@/hooks/useAnimatedAction";
import { AbortableRequestPool } from "@/shared/requestLifecycle";
import { directDelayTestUrl } from "@/shared/directDelay";
import type { Json, Notify } from "@/shared/types";

import {
  proxyDelayTarget,
  isDirectProxy,
  DIRECT_DELAY_TEST_URL,
  requestProxyDelay,
  proxyNodeDelayRequest,
  measurableProxyCardMembers,
  runProxyCardDelayTests,
  type ProxyCardModel,
  type ProxyDelaySample,
} from "./proxyLogic";

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
  const [testingNodes, setTestingNodes] = useState<Set<string>>(new Set());
  const [testingCards, setTestingCards] = useState<Set<string>>(new Set());
  const testingCardsRef = useRef(new Set<string>());
  const testingGroupsRef = useRef(new Set<string>());
  const pendingTests = useRef(new Map<string, Promise<number>>());
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
    lifecycle.current += 1;
    return () => {
      lifecycle.current += 1;
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

  const measure = useCallback((name: string) => {
    const target = proxyDelayTarget(name, data);
    const identity = JSON.stringify([providerByNode[target] || "", target]);
    const activeActions = actions.current;
    if (!activeActions) return Promise.reject(new Error("测速会话已关闭"));
    return requestProxyDelay(pendingTests.current, identity, async () => {
      const action = activeActions.begin();
      const activeLifecycle = lifecycle.current;
      setTestingNodes(current => new Set(current).add(target));
      let delay: number | null = null;
      try {
        let directUrl: string | undefined;
        if (isDirectProxy(data[target])) {
          try {
            directUrl = directDelayTestUrl((await readManagerSettings(action.signal)).directDelayTest);
            lastDirectDelayUrl.current = directUrl;
          } catch (error) {
            if (action.signal.aborted) throw error;
            directUrl = lastDirectDelayUrl.current ?? DIRECT_DELAY_TEST_URL;
            notify(`直连测速设置读取失败，本次使用${lastDirectDelayUrl.current ? "上次读取的地址" : "默认小米地址"}`, "error");
          }
        }
        const result = await withMinimumSpin(controllerApi<Json>(
          proxyNodeDelayRequest(target, providerByNode[target], data[target], directUrl), { signal: action.signal },
        ));
        delay = Number(result.delay) > 0 ? Number(result.delay) : null;
        return delay ?? 0;
      } finally {
        activeActions.finish(action);
        if (!action.signal.aborted && lifecycle.current === activeLifecycle) {
          setDelays(current => ({ ...current, [target]: { delay, testedAt: Date.now() } }));
          setTestingNodes(current => { const next = new Set(current); next.delete(target); return next; });
        }
      }
    });
  }, [data, notify, providerByNode]);

  const testNode = useCallback(async (name: string) => {
    const activeLifecycle = lifecycle.current;
    try {
      const delay = await measure(name);
      if (lifecycle.current === activeLifecycle) setDelays(current => ({ ...current, [name]: { delay: delay || null, testedAt: Date.now() } }));
    } catch (error) {
      if (lifecycle.current === activeLifecycle) notify(`${name} 测速失败：${(error as Error).message}`, "error");
    }
  }, [measure, notify]);

  const testCard = useCallback(async (card: ProxyCardModel) => {
    if (!card.grouped || testingCardsRef.current.has(card.key)) return;
    const members = measurableProxyCardMembers(card, data, providerByNode);
    if (!members.length) {
      notify("该组合没有可测速的真实节点", "error");
      return;
    }
    const activeLifecycle = lifecycle.current;
    testingCardsRef.current = new Set(testingCardsRef.current).add(card.key);
    setTestingCards(testingCardsRef.current);
    try {
      await runProxyCardDelayTests(members, ({ name }) => measure(name), (name, delay) => {
        if (lifecycle.current === activeLifecycle) setDelays(current => ({ ...current, [name]: { delay, testedAt: Date.now() } }));
      });
    } finally {
      const next = new Set(testingCardsRef.current); next.delete(card.key); testingCardsRef.current = next;
      if (lifecycle.current === activeLifecycle) setTestingCards(next);
    }
  }, [data, measure, notify, providerByNode]);

  const testGroup = useCallback(async (groupName: string) => {
    if (testingGroupsRef.current.has(groupName)) return;
    const activeLifecycle = lifecycle.current;
    testingGroupsRef.current = new Set(testingGroupsRef.current).add(groupName);
    setTestingGroups(testingGroupsRef.current);
    try {
      const members = [...new Set(((data[groupName]?.all || []) as unknown[]).map(String))].map(name => ({ name }));
      const result = await runProxyCardDelayTests(members, ({ name }) => measure(name), (name, delay) => {
        if (lifecycle.current === activeLifecycle) setDelays(current => ({ ...current, [name]: { delay, testedAt: Date.now() } }));
      });
      if (lifecycle.current === activeLifecycle) {
        const message = `${groupName} 测速完成：成功 ${result.succeeded}，失败 ${result.failed}`;
        if (result.failed) notify(message, "error");
        else notify(message);
      }
    } finally {
      const next = new Set(testingGroupsRef.current); next.delete(groupName); testingGroupsRef.current = next;
      if (lifecycle.current === activeLifecycle) setTestingGroups(next);
    }
  }, [data, measure, notify]);

  return {
    delays,
    testingGroups,
    testingNodes,
    testingCards,
    identifyingCountries,
    identifyCountries,
    testNode,
    testCard,
    testGroup,
  };
}
