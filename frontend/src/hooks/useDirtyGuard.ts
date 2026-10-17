// 将页面未保存和不可中断写入状态注册到全局离开防护，并在卸载时可靠清除。
import { useEffect } from "react";
import { useUiState } from "../app/state/uiState";

export function useDirtyGuard(dirty: boolean, pendingWrite: boolean) {
  const { setDirtyGuard, confirmDiscard } = useUiState();
  useEffect(() => {
    setDirtyGuard({ dirty, pendingWrite });
    return () => setDirtyGuard({ dirty: false, pendingWrite: false });
  }, [dirty, pendingWrite, setDirtyGuard]);
  return confirmDiscard;
}
