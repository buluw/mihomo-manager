import { useCallback, useEffect, useRef, useState } from "react";

import { createConfigChangeSource, listConfigFiles, readConfigFile, readRuntimeLoadState, type ConfigFileRecord } from "@/api/configClient";
import { applyRuntimeConfig, RuntimeApplyError, confirmedRuntimeSource } from "@/shared/runtimeApplication";
import type { Notify } from "@/shared/types";
import { proxyConfigActionLabel, proxyConfigListFailure, proxyConfigSelection } from "./proxyConfigSwitcherState";

const proxyConfigListCache: { initialized: boolean; files: ConfigFileRecord[] } = {
  initialized: false,
  files: [],
};

export function useProxyConfigSwitcher(notify: Notify, refreshRuntime: () => Promise<void>) {
  const [files, setFiles] = useState<ConfigFileRecord[]>(proxyConfigListCache.files);
  const [target, setTarget] = useState("");
  const [loaded, setLoaded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [listLoading, setListLoading] = useState(!proxyConfigListCache.initialized);
  const [listMessage, setListMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  const targetRef = useRef(target);
  targetRef.current = target;
  const selectTarget = useCallback((name: string) => {
    targetRef.current = name;
    setTarget(name);
  }, []);

  const refreshFiles = useCallback(async (signal?: AbortSignal) => {
    const [next, runtime] = await Promise.all([
      listConfigFiles(signal),
      readRuntimeLoadState(signal),
    ]);
    if (!mounted.current || signal?.aborted) return;
    const selection = proxyConfigSelection(next, runtime, targetRef.current);
    proxyConfigListCache.initialized = true;
    proxyConfigListCache.files = next;
    setFiles(selection.files);
    setListMessage(selection.loaded ? null : "运行配置身份未知；请选择配置并明确载入");
    setTarget(selection.target);
    setLoaded(selection.loaded);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    setListLoading(true);
    void refreshFiles(controller.signal)
      .catch(() => {
        const failure = proxyConfigListFailure(proxyConfigListCache.files.length > 0, controller.signal.aborted);
        if (!mounted.current || controller.signal.aborted) return;
        setListMessage(failure.message);
        setLoaded(null);
        if (failure.notify) notify(failure.message, "error");
      })
      .finally(() => mounted.current && setListLoading(false));
    const changes = createConfigChangeSource(() => { void refreshFiles().catch(() => undefined); });
    return () => { mounted.current = false; controller.abort(); changes.close(); };
  }, [notify, refreshFiles]);

  const apply = useCallback(async (name = targetRef.current) => {
    if (!name || busyRef.current) return false;
    const selectedTarget = name;
    busyRef.current = true;
    selectTarget(selectedTarget);
    setBusy(true);
    setListMessage(null);
    try {
      const snapshot = await readConfigFile(selectedTarget);
      if (!mounted.current || targetRef.current !== selectedTarget) return false;
      const recorded = await applyRuntimeConfig(snapshot);
      if (!mounted.current || targetRef.current !== selectedTarget) return false;
      setLoaded(confirmedRuntimeSource(recorded)?.name ?? null);
      notify(`${snapshot.name} 已生成并加载`);
      void Promise.all([refreshRuntime(), refreshFiles()]).catch(() => {
        if (mounted.current) setListMessage("配置已应用，列表刷新失败；可手动刷新");
      });
      return true;
    } catch (error) {
      if (mounted.current) setLoaded(null);
      await Promise.all([
        refreshFiles().catch(() => {
          if (mounted.current) setListMessage("无法核对配置版本，运行配置身份未知");
        }),
        refreshRuntime().catch(() => undefined),
      ]);
      const message = error instanceof RuntimeApplyError ? error.message : "运行配置应用失败，运行身份未知";
      if (mounted.current) setListMessage(message);
      notify(message, "error");
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [notify, refreshFiles, refreshRuntime, selectTarget]);

  return { files, target, setTarget: selectTarget, loaded, busy, listLoading, listMessage, actionLabel: proxyConfigActionLabel(target, loaded), apply };
}
