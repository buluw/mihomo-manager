import { useCallback, useEffect, useRef, useState } from "react";

import {
  ConfigError,
  readProxyNodeSettings,
  recognizeProxyNodeCountry,
  saveProxyNodeSettings,
  type ProxyAddresses,
  type ProxyNodeSettings,
} from "@/api/configClient";

import type { AvailableProxyNode } from "./proxyMergeSettings";
import { proxyIdentityKey } from "./proxyMergeSettings";
import { formatProxyCountry, proxyAddress, proxyCountryLabel } from "./proxyLogic";
import {
  commitProxyRegionDrafts,
  EMPTY_PROXY_NODE_SETTINGS,
  ProxyNodeInfoSaveGuard,
  proxyRegionDraftValue,
  previewAutomaticProxyRegion,
  type ProxyRegionDraftRevisions,
  type ProxyRegionDrafts,
} from "./proxyNodeInfo";
import {
  ProxyNodeInfoLifecycleHost,
  publishProxyNodeInfoSettings,
} from "./proxyNodeInfoLifecycle";
import { LatestRequestController } from "@/shared/requestLifecycle";

function message(error: unknown) {
  if (error instanceof ConfigError) {
    if (error.code === "validation_failed") return "Mihomo 校验未通过，磁盘配置未更新";
    if (error.code === "config_conflict") return "配置已被其他设备修改，请重新选择后再试";
    if (error.code === "proxy_node_settings_conflict") return "节点地区已被其他设备修改，请重新打开后再试";
    if (error.code === "proxy_node_info_transaction_failed") return "保存未能完整完成，请重新读取后确认";
  }
  return "节点信息服务暂不可用，草稿已保留";
}

export function useProxyNodeInfo(nodes: AvailableProxyNode[], addresses: ProxyAddresses, refreshAddresses: () => Promise<ProxyAddresses | null>) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<ProxyNodeSettings>(EMPTY_PROXY_NODE_SETTINGS);
  const [identityKey, setIdentityKey] = useState("");
  const [region, setRegion] = useState("");
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recognizing, setRecognizing] = useState<"ip-api" | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifecycleHost = useRef(new ProxyNodeInfoLifecycleHost()).current;
  const saveGuard = useRef(new ProxyNodeInfoSaveGuard()).current;
  const recognition = useRef(new LatestRequestController()).current;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const draftsRef = useRef<ProxyRegionDrafts>({});
  const draftRevisionsRef = useRef<ProxyRegionDraftRevisions>({});
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const selected = nodes.find((node) => `${node.provider}\0${node.name}` === identityKey) ?? null;
  const automaticRegion = useCallback((node: AvailableProxyNode) => {
    const address = proxyAddress(node.name, node.provider, addresses);
    return proxyCountryLabel(address, addresses);
  }, [addresses]);
  const server = selected ? proxyAddress(selected.name, selected.provider, addresses) ?? "" : "";

  useEffect(() => {
    recognition.cancel();
    setRecognizing(null);
  }, [addresses.source?.loadVersion, recognition]);

  useEffect(() => {
    const { lifecycle, cleanup } = lifecycleHost.setup();
    const request = lifecycle.beginSettings();
    if (request) {
      setSettingsLoading(true);
      void readProxyNodeSettings(request.signal)
        .then((next) => {
          if (!request.isCurrent()) return;
          settingsRef.current = next;
          setSettings(next);
        })
        .catch(() => undefined)
        .finally(() => request.finish() && setSettingsLoading(false));
    }
    return cleanup;
  }, [lifecycleHost]);

  const changeOpenWithIdentity = useCallback((next: boolean, initialIdentityKey?: string) => {
    saveGuard.edit(() => {
      setOpen(next);
      setSessionLoaded(false);
      const lifecycle = lifecycleHost.current();
      if (!lifecycle) {
        setError("节点信息会话尚未就绪");
        return;
      }
      if (!next) {
        recognition.cancel();
        setRecognizing(null);
        lifecycle.closeSession();
        setSettingsLoading(false);
        draftsRef.current = {};
        return;
      }
      draftsRef.current = {};
      recognition.cancel();
      setRecognizing(null);
      const node = initialIdentityKey
        ? nodes.find((entry) => proxyIdentityKey(entry) === initialIdentityKey) ?? null
        : selected;
      const key = node ? proxyIdentityKey(node) : "";
      setIdentityKey(key);
      setRegion(node ? proxyRegionDraftValue({}, settings, node, automaticRegion(node)) : "");
      const generation = lifecycle.openSession(key);
      const request = lifecycle.beginSettings(generation);
      if (!request) return;
      setSettingsLoading(true);
      setError(null);
      void readProxyNodeSettings(request.signal)
      .then((nextSettings) => {
        const published = publishProxyNodeInfoSettings(
          lifecycle,
          request,
          (currentKey) => nodesRef.current.find((entry) => `${entry.provider}\0${entry.name}` === currentKey) ?? null,
        );
        if (!published) return;
        settingsRef.current = nextSettings;
        setSettings(nextSettings);
        setSessionLoaded(true);
        if (published.selected) {
          setIdentityKey(published.identityKey);
          setRegion(proxyRegionDraftValue(
            draftsRef.current,
            nextSettings,
            published.selected,
            automaticRegion(published.selected),
          ));
        }
      })
      .catch((reason) => request.isCurrent() && setError(message(reason)))
      .finally(() => request.finish() && setSettingsLoading(false));
    });
  }, [automaticRegion, lifecycleHost, nodes, recognition, saveGuard, selected, settings]);
  const changeOpen = useCallback((next: boolean) => {
    changeOpenWithIdentity(next);
  }, [changeOpenWithIdentity]);
  const openForIdentity = useCallback((key: string) => {
    changeOpenWithIdentity(true, key);
  }, [changeOpenWithIdentity]);

  const changeRegion = useCallback((value: string) => {
    if (!selected) return;
    saveGuard.edit(() => {
      const key = proxyIdentityKey(selected);
      draftRevisionsRef.current[key] = (draftRevisionsRef.current[key] ?? 0) + 1;
      draftsRef.current = { ...draftsRef.current, [key]: value || null };
      setRegion(value);
    });
  }, [saveGuard, selected]);

  const restoreAutomaticRegion = useCallback(() => {
    if (!selected) return;
    saveGuard.edit(() => {
      const key = proxyIdentityKey(selected);
      draftRevisionsRef.current[key] = (draftRevisionsRef.current[key] ?? 0) + 1;
      draftsRef.current = { ...draftsRef.current, [key]: null };
      setRegion(automaticRegion(selected) ?? "");
    });
  }, [automaticRegion, saveGuard, selected]);

  const recognizeIpApi = useCallback(async () => {
    if (!selected || recognizing || saving) return false;
    if (!addresses.source || !server) {
      setError(!addresses.source ? "节点来源无法确认，请刷新或成功加载配置后重试" : "当前节点没有可用的 Server 地址，无法识别地区");
      return false;
    }
    const key = proxyIdentityKey(selected);
    const startedDraftRevision = draftRevisionsRef.current[key] ?? 0;
    const request = recognition.begin();
    setRecognizing("ip-api");
    setError(null);
    try {
      const country = await recognizeProxyNodeCountry(selected, request.signal, addresses.source.loadVersion);
      const lifecycle = lifecycleHost.current();
      if (!request.isCurrent() || !lifecycle?.isOpenIdentity(key) || (draftRevisionsRef.current[key] ?? 0) !== startedDraftRevision) return false;
      const label = formatProxyCountry(country);
      draftsRef.current = previewAutomaticProxyRegion(draftsRef.current, key);
      setRegion(label);
      return true;
    } catch (reason) {
      const lifecycle = lifecycleHost.current();
      if (request.isCurrent() && lifecycle?.isOpenIdentity(key)) {
        setError(reason instanceof ConfigError && reason.code === "proxy_address_source_unavailable"
          ? "节点来源已变化或没有可查询的公网地址，请刷新后重试"
          : "当前地址解析或 ip-api.com 查询失败，未识别出地区");
      }
      return false;
    } finally {
      if (request.finish()) setRecognizing(null);
    }
  }, [addresses.source, lifecycleHost, recognition, recognizing, saving, selected, server]);

  const save = useCallback(async () => {
    const identity = selected ? `${selected.provider}\0${selected.name}` : "";
    const lifecycle = lifecycleHost.current();
    if (!lifecycle) {
      setError("节点信息会话尚未就绪");
      return false;
    }
    if (!selected || !sessionLoaded || !lifecycle.isOpenIdentity(identity)) {
      setError("节点信息已变化，请重新打开后再保存");
      return false;
    }
    if (recognizing || !saveGuard.acquire()) return false;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveProxyNodeSettings(commitProxyRegionDrafts(settings, nodes, draftsRef.current));
      settingsRef.current = saved;
      setSettings(saved);
      draftsRef.current = {};
      setOpen(false);
      void refreshAddresses();
      return true;
    } catch (reason) {
      setError(reason instanceof ConfigError ? message(reason) : reason instanceof Error ? reason.message : message(reason));
      return false;
    } finally {
      saveGuard.release();
      setSaving(false);
    }
  }, [lifecycleHost, nodes, recognizing, refreshAddresses, saveGuard, selected, sessionLoaded, settings]);

  return {
    open, changeOpen, openForIdentity, settings, selected, identityKey, server,
    region, setRegion: changeRegion, restoreAutomaticRegion,
    addressSource: addresses.source?.name ?? null,
    recognizing, recognizeIpApi,
    loading: settingsLoading, saving, sessionLoaded, error, save,
  };
}
