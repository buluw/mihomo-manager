import { useCallback, useEffect, useRef, useState } from "react";

import { ConfigError, createConfigChangeSource, type ConfigSnapshot } from "@/api/configClient";
import { readControllerRules } from "@/api/controllerClient";
import { useRegisterPageRefresh } from "@/app/pageRefresh";
import { useDirtyGuard } from "@/hooks/useDirtyGuard";
import { applyRuntimeConfig, RUNTIME_CONFIG_LOADED_EVENT } from "@/shared/runtimeApplication";
import type { Notify } from "@/shared/types";
import { applyRuleEditorAction, commitRuleEditorSave, createRuleEditorValue, ruleOrderDirty, RuleSaveRebaseError, saveRuleConfiguration, type RuleEditAction, type RuleEditorValue } from "./ruleEditorState";
import { RuleRequestLifecycle } from "./ruleRequestLifecycle";
import { readRuleEditSnapshot, readRuleSource, type RuleRuntimeCache, type RuleSource } from "./ruleRuntime";
import { configProxyGroupNames, configRuleItems, configRuleProviderNames, ruleItems, type RuleItem } from "./ruleViewModel";

export function useRuleWorkspace(notify: Notify) {
  const [runtimeRules, setRuntimeRules] = useState<RuleItem[]>([]);
  const [runtimeMessage, setRuntimeMessage] = useState<string | null>(null);
  const [source, setSource] = useState<RuleSource | null>(null);
  const [sourceLoading, setSourceLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editor, setEditor] = useState(() => createRuleEditorValue([]));
  const editorRef = useRef(editor);
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null);
  const [editSource, setEditSource] = useState<RuleSource | null>(null);
  const [editorMessage, setEditorMessage] = useState<string | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingApply, setPendingApply] = useState(false);
  const busyRef = useRef(false);
  const [requests] = useState(() => new RuleRequestLifecycle());
  const [editRequests] = useState(() => new RuleRequestLifecycle());
  const cache = useRef<RuleRuntimeCache | null>(null);
  const dirty = ruleOrderDirty(editor.draft, editor.saved);
  useDirtyGuard(dirty, saving);

  const publishEditor = useCallback((next: RuleEditorValue) => {
    editorRef.current = next;
    setEditor(next);
  }, []);

  const load = useCallback(async (report = true) => {
    const request = requests.begin();
    if (!request) return;
    setRefreshing(true);
    setSourceLoading(true);
    try {
      const response = await readControllerRules(request.signal);
      if (!request.isCurrent()) return;
      const next = ruleItems(response.rules);
      setRuntimeRules(next);
      setLoading(false);
      setRuntimeMessage(null);
      const association = await readRuleSource(next, request.signal, cache.current);
      if (!request.isCurrent()) return;
      cache.current = association.cache;
      setSource(association.source);
    } catch (error) {
      if (!request.isCurrent()) return;
      setSource(null);
      setRuntimeMessage("Core 规则读取失败；已有列表仅为上次读取结果");
      if (report) notify(error instanceof Error ? error.message : "Core 规则读取失败", "error");
    } finally {
      if (request.finish()) { setRefreshing(false); setLoading(false); setSourceLoading(false); }
    }
  }, [notify, requests]);
  useRegisterPageRefresh(() => load());

  useEffect(() => {
    const cleanupRuntime = requests.setup();
    const cleanupEditor = editRequests.setup();
    const refresh = () => { if (!document.hidden) void load(false); };
    void load(false);
    const interval = window.setInterval(refresh, 30_000);
    const changes = createConfigChangeSource((event) => { if (event.operation !== "ready") refresh(); });
    window.addEventListener("focus", refresh);
    window.addEventListener(RUNTIME_CONFIG_LOADED_EVENT, refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cleanupRuntime(); cleanupEditor(); changes.close(); window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(RUNTIME_CONFIG_LOADED_EVENT, refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [editRequests, load, requests]);

  const change = useCallback(async (action: RuleEditAction, initial = { rules: runtimeRules, source }) => {
    if (busyRef.current) return false;
    if (editing) {
      publishEditor(applyRuleEditorAction(editorRef.current, action));
      return true;
    }
    const request = editRequests.begin();
    if (!request) return false;
    busyRef.current = true; setEditorBusy(true);
    try {
      const prepared = await readRuleEditSnapshot(initial.rules, initial.source, request.signal, cache.current);
      if (!request.isCurrent()) return false;
      const next = applyRuleEditorAction(createRuleEditorValue(prepared.rules), action, initial.rules);
      cache.current = prepared.cache;
      if (!ruleOrderDirty(next.draft, next.saved)) return true;
      setSnapshot(prepared.disk); setEditSource(prepared.source); publishEditor(next);
      setEditorMessage(null); setPendingApply(false); setEditing(true);
      return true;
    } catch (error) {
      if (request.isCurrent()) {
        const message = error instanceof Error ? error.message : "规则草稿准备失败";
        setEditorMessage(message); notify(message, "error");
      }
      return false;
    } finally { busyRef.current = false; if (request.finish()) setEditorBusy(false); }
  }, [editing, editRequests, notify, publishEditor, runtimeRules, source]);

  const save = useCallback(async () => {
    if (busyRef.current || !snapshot || !editSource || (!pendingApply && !ruleOrderDirty(editorRef.current.draft, editorRef.current.saved))) return;
    const request = editRequests.begin();
    if (!request) return;
    busyRef.current = true; setSaving(true);
    const submitted = editorRef.current.draft;
    try {
      const response = await readControllerRules(request.signal);
      const association = await readRuleSource(ruleItems(response.rules), request.signal, cache.current);
      if (association.source?.name !== editSource.name || association.source.generatedVersion !== editSource.generatedVersion) throw new Error("运行来源已变化或无法确认；编辑草稿已保留，请放弃草稿后重新选择编辑来源");
      if (!request.isCurrent()) return;
      const result = ruleOrderDirty(submitted, editorRef.current.saved)
        ? await saveRuleConfiguration({ name: snapshot.name, content: snapshot.content, sha256: snapshot.sha256, rules: submitted })
        : { disk: snapshot, runtimeState: await applyRuntimeConfig(snapshot), runtimeError: null };
      if (!request.isCurrent()) return;
      setSnapshot(result.disk);
      publishEditor(commitRuleEditorSave(editorRef.current, submitted, configRuleItems(result.disk.content).map((rule, index) => ({ ...rule, type: submitted[index]!.type }))));
      if (result.runtimeError) {
        setPendingApply(true);
        setEditorMessage(result.runtimeError.message);
        notify(result.runtimeError.message, "error");
      } else {
        setPendingApply(false); setEditing(false); setEditorMessage(null);
        notify("规则已保存并加载");
      }
      await load(false);
    } catch (error) {
      if (!request.isCurrent()) return;
      const text = error instanceof ConfigError && error.code === "config_conflict"
        ? "源文件已被其他设备修改；草稿已保留，请重新读取后处理"
        : error instanceof RuleSaveRebaseError ? "磁盘可能已保存；草稿已保留，请核对源文件版本"
        : error instanceof Error ? error.message : "规则保存失败";
      setEditorMessage(text); notify(text, "error");
    } finally { busyRef.current = false; if (request.finish()) setSaving(false); }
  }, [editRequests, editSource, load, notify, pendingApply, publishEditor, snapshot]);

  const discard = () => {
    if (busyRef.current) return;
    publishEditor(createRuleEditorValue([])); setSnapshot(null); setEditSource(null); setEditorMessage(null); setEditing(false);
    setPendingApply(false); void load(false);
  };
  return { runtimeRules, runtimeMessage, source, sourceLoading, loading, refreshing, editing, editor, snapshot, editorMessage, editorBusy, saving, pendingApply, dirty, change, save, discard,
    actionContext: { rules: runtimeRules, source },
    proxyGroups: editing && snapshot ? configProxyGroupNames(snapshot.content) : cache.current?.proxyGroups ?? [],
    ruleProviders: editing && snapshot ? configRuleProviderNames(snapshot.content) : cache.current?.ruleProviders ?? [] };
}
