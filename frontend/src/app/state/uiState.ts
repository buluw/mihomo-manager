// 定义跨页面共享的 dirty、Dialog 与主题状态契约。
import { createContext, useContext } from "react";

import type { DirtyGuardState } from "./dirtyGuard";

export type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

export type PromptOptions = ConfirmOptions & {
  label: string;
  initialValue?: string;
  placeholder?: string;
};

export type UiState = {
  dirty: boolean;
  pendingWrite: boolean;
  setDirtyGuard: (value: DirtyGuardState) => void;
  confirmDiscard: () => Promise<boolean>;
  askConfirm: (options: ConfirmOptions) => Promise<boolean>;
  askPrompt: (options: PromptOptions) => Promise<string | null>;
};

export const UiStateContext = createContext<UiState | null>(null);

export function useUiState() {
  const value = useContext(UiStateContext);
  if (!value) throw new Error("useUiState must be used inside UiStateProvider");
  return value;
}
