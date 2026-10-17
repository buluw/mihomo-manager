import { useCallback, useEffect, useRef, useState } from "react";

import {
  ConfigError,
  readProxyMergeSettings,
  saveProxyMergeSettings,
  type ProxyMergeSettings,
} from "@/api/configClient";

import { beginProxyMergeDraft, persistLoadedProxyMergeDraft } from "./proxyMergeSettings";

const EMPTY_SETTINGS: ProxyMergeSettings = {
  schemaVersion: 1,
  version: 0,
  groups: [],
  exclusions: [],
};

let cachedSettings: ProxyMergeSettings | null = null;

function mergeSettingsError(error: unknown, operation: "load" | "save") {
  if (error instanceof ConfigError && error.code === "proxy_merge_settings_conflict") {
    return "设置已被其他设备更新，请关闭弹窗后重新打开再修改";
  }
  if (error instanceof ConfigError && error.code === "invalid_proxy_merge_settings") {
    return "合并设置内容不合法，请检查名称和成员";
  }
  return operation === "load"
    ? "合并设置服务暂不可用，代理管理仍可继续使用"
    : "合并设置暂时无法保存，草稿已保留";
}

export function useProxyMergeSettings() {
  const [settings, setSettings] = useState<ProxyMergeSettings>(() => cachedSettings || EMPTY_SETTINGS);
  const [draft, setDraft] = useState<ProxyMergeSettings>(() => beginProxyMergeDraft(cachedSettings || EMPTY_SETTINGS));
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(!cachedSettings);
  const [saving, setSaving] = useState(false);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftDirty = useRef(false);
  const savingRef = useRef(false);
  const sessionGeneration = useRef(0);
  const request = useRef<AbortController | null>(null);

  const load = useCallback((openGeneration?: number) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    void readProxyMergeSettings(controller.signal)
      .then((next) => {
        if (request.current !== controller) return;
        cachedSettings = next;
        setSettings(next);
        if (!draftDirty.current) setDraft(beginProxyMergeDraft(next));
        if (openGeneration != null && sessionGeneration.current === openGeneration) {
          setSessionLoaded(true);
        }
        setError(null);
      })
      .catch((requestError) => {
        if (!controller.signal.aborted && request.current === controller) setError(mergeSettingsError(requestError, "load"));
      })
      .finally(() => {
        if (!controller.signal.aborted && request.current === controller) setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
    return () => request.current?.abort();
  }, [load]);

  const changeOpen = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      const generation = sessionGeneration.current + 1;
      sessionGeneration.current = generation;
      setSessionLoaded(false);
      draftDirty.current = false;
      setDraft(beginProxyMergeDraft(settings));
      setError(null);
      load(generation);
    } else {
      sessionGeneration.current += 1;
      setSessionLoaded(false);
    }
  }, [load, settings]);

  const save = useCallback(async () => {
    if (!sessionLoaded || savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const saved = await persistLoadedProxyMergeDraft(draft, sessionLoaded, false, saveProxyMergeSettings);
      if (!saved) return false;
      cachedSettings = saved;
      setSettings(saved);
      draftDirty.current = false;
      setDraft(beginProxyMergeDraft(saved));
      setOpen(false);
      return true;
    } catch (saveError) {
      setError(mergeSettingsError(saveError, "save"));
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [draft, sessionLoaded]);

  const updateDraft = useCallback((next: ProxyMergeSettings) => {
    draftDirty.current = true;
    setDraft(next);
  }, []);

  return {
    settings,
    draft,
    setDraft: updateDraft,
    open,
    changeOpen,
    loading,
    saving,
    sessionLoaded,
    error,
    save,
  };
}
