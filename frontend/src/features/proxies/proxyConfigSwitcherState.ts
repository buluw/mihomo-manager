import type { ConfigFileRecord, RuntimeLoadState } from "../../api/configClient.ts";
import { confirmedRuntimeSource } from "../../shared/runtimeApplication.ts";

export function proxyConfigActionLabel(target: string, loaded: string | null) {
  return target && target === loaded ? "重载配置" : "切换配置";
}

export function proxyConfigListFailure(hasSnapshot: boolean, aborted: boolean) {
  return {
    preserveSnapshot: hasSnapshot,
    notify: !aborted && !hasSnapshot,
    message: hasSnapshot ? "配置列表刷新失败，继续显示上次快照" : "配置列表暂不可用",
  };
}
export function proxyConfigSelection(files: ConfigFileRecord[], runtime: RuntimeLoadState | null, target: string) {
  const source = confirmedRuntimeSource(runtime);
  const loaded = files.find(file => file.name === source?.name && file.sha256 === source.sha256)?.name ?? null;
  return {
    files: [...files].sort((left, right) => Number(right.name === loaded) - Number(left.name === loaded)),
    loaded,
    target: files.some(file => file.name === target) ? target : loaded ?? "",
  };
}
