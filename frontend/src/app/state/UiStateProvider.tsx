import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBlocker, useLocation } from "react-router";
import { TriangleAlert } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UiStateContext, type ConfirmOptions, type PromptOptions } from "./uiState";
import {
  navigationBlockReason,
  shouldBlockNavigation,
  type DirtyGuardState,
} from "./dirtyGuard";

type DialogState =
  | ({ kind: "confirm" } & Required<Pick<ConfirmOptions, "title" | "confirmLabel" | "cancelLabel" | "danger">> & Pick<ConfirmOptions, "message">)
  | ({ kind: "prompt" } & Required<Pick<PromptOptions, "title" | "confirmLabel" | "cancelLabel" | "danger" | "label">> & Pick<PromptOptions, "message" | "initialValue" | "placeholder">);

function ConfirmDialog({
  state,
  onResolve,
}: {
  state: Extract<DialogState, { kind: "confirm" }>;
  onResolve: (value: boolean) => void;
}) {
  return (
    <AlertDialog open onOpenChange={(open) => !open && onResolve(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          {state.danger && (
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <TriangleAlert />
            </AlertDialogMedia>
          )}
          <AlertDialogTitle>{state.title}</AlertDialogTitle>
          {state.message && <AlertDialogDescription>{state.message}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          {state.cancelLabel && (
            <AlertDialogCancel>{state.cancelLabel}</AlertDialogCancel>
          )}
          <AlertDialogAction
            variant={state.danger ? "destructive" : "default"}
            onClick={() => onResolve(true)}
          >
            {state.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PromptDialog({
  state,
  onResolve,
}: {
  state: Extract<DialogState, { kind: "prompt" }>;
  onResolve: (value: string | null) => void;
}) {
  const [value, setValue] = useState(state.initialValue ?? "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = value.trim();
    if (next) onResolve(next);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onResolve(null)}>
      <DialogContent showCloseButton={false}>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{state.title}</DialogTitle>
            {state.message && <DialogDescription>{state.message}</DialogDescription>}
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="global-prompt-input">{state.label}</Label>
            <Input
              id="global-prompt-input"
              autoFocus
              autoComplete="off"
              maxLength={120}
              placeholder={state.placeholder}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onResolve(null)}>
              {state.cancelLabel}
            </Button>
            <Button type="submit" variant={state.danger ? "destructive" : "default"} disabled={!value.trim()}>
              {state.confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function UiStateProvider({ children }: { children: ReactNode }) {
  const [guard, setDirtyGuard] = useState<DirtyGuardState>({
    dirty: false,
    pendingWrite: false,
  });
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const resolverRef = useRef<((value: boolean | string | null) => void) | null>(null);
  const location = useLocation();
  const previousLocation = useRef(location);
  const runtimeReturnLocation = useRef<typeof location | null>(null);
  if (location.key !== previousLocation.current.key) {
    if (location.pathname !== "/runtime-config") runtimeReturnLocation.current = null;
    else if (previousLocation.current.pathname !== "/runtime-config") runtimeReturnLocation.current = previousLocation.current;
    previousLocation.current = location;
  }
  const blocker = useBlocker(({ currentLocation, nextLocation, historyAction }) =>
    shouldBlockNavigation(guard, currentLocation, nextLocation, runtimeReturnLocation.current, historyAction),
  );
  const resolvedNavigation = useRef<typeof blocker | null>(null);
  const blockedNavigationReason =
    blocker.state === "blocked" ? navigationBlockReason(guard) : null;
  const pendingNavigation = blockedNavigationReason === "pending-write";

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!navigationBlockReason(guard)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [guard]);

  const openDialog = useCallback((next: DialogState, resolve: (value: boolean | string | null) => void) => {
    resolverRef.current?.(null);
    resolverRef.current = resolve;
    setDialog(next);
  }, []);

  const resolveDialog = useCallback((value: boolean | string | null) => {
    const resolver = resolverRef.current;
    resolverRef.current = null;
    setDialog(null);
    resolver?.(value);
  }, []);

  const askConfirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) =>
        openDialog(
          {
            kind: "confirm",
            title: options.title,
            message: options.message,
            confirmLabel: options.confirmLabel ?? "确认",
            cancelLabel: options.cancelLabel ?? "取消",
            danger: options.danger ?? false,
          },
          (value) => resolve(value === true),
        ),
      ),
    [openDialog],
  );

  const askPrompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((resolve) =>
        openDialog(
          {
            kind: "prompt",
            title: options.title,
            message: options.message,
            confirmLabel: options.confirmLabel ?? "确认",
            cancelLabel: options.cancelLabel ?? "取消",
            danger: options.danger ?? false,
            label: options.label,
            initialValue: options.initialValue,
            placeholder: options.placeholder,
          },
          (value) => resolve(typeof value === "string" ? value : null),
        ),
      ),
    [openDialog],
  );

  const confirmDiscard = useCallback(async () => {
    if (guard.pendingWrite) return false;
    if (!guard.dirty) return true;
    const accepted = await askConfirm({
      title: "放弃未保存的修改？",
      message: "当前页面的修改还没有保存，离开后将无法恢复。",
      confirmLabel: "放弃并离开",
      danger: true,
    });
    if (accepted) setDirtyGuard((current) => ({ ...current, dirty: false }));
    return accepted;
  }, [askConfirm, guard]);

  useEffect(() => {
    if (blocker.state !== "blocked" || resolvedNavigation.current === blocker) return;
    if (!blockedNavigationReason) {
      resolvedNavigation.current = blocker;
      blocker.proceed();
      return;
    }
    if (dialog) resolveDialog(null);
  }, [blockedNavigationReason, blocker, dialog, resolveDialog]);

  const resetBlockedNavigation = useCallback(() => {
    if (blocker.state === "blocked" && resolvedNavigation.current !== blocker) {
      resolvedNavigation.current = blocker;
      blocker.reset();
    }
  }, [blocker]);

  const proceedBlockedNavigation = useCallback(() => {
    if (blocker.state !== "blocked" || resolvedNavigation.current === blocker) return;
    const reason = navigationBlockReason(guard);
    if (reason === "pending-write") return;
    resolvedNavigation.current = blocker;
    blocker.proceed();
  }, [blocker, guard]);

  const value = useMemo(
    () => ({
      dirty: guard.dirty,
      pendingWrite: guard.pendingWrite,
      setDirtyGuard,
      confirmDiscard,
      askConfirm,
      askPrompt,
    }),
    [askConfirm, askPrompt, confirmDiscard, guard.dirty, guard.pendingWrite, setDirtyGuard],
  );

  return (
    <UiStateContext.Provider value={value}>
      {children}
      {blockedNavigationReason ? (
        <ConfirmDialog
          state={{
            kind: "confirm",
            title: pendingNavigation
              ? "写入尚未完成"
              : "放弃未保存的修改？",
            message: pendingNavigation
              ? "当前操作尚未完成，请等待结果确认后再离开。"
              : "当前页面的修改还没有保存，离开后将无法恢复。",
            confirmLabel: pendingNavigation ? "继续等待" : "放弃并离开",
            cancelLabel: pendingNavigation ? "" : "取消",
            danger: blockedNavigationReason === "dirty",
          }}
          onResolve={(accepted) => {
            if (accepted && !pendingNavigation)
              proceedBlockedNavigation();
            else resetBlockedNavigation();
          }}
        />
      ) : (
        <>
          {dialog?.kind === "confirm" && <ConfirmDialog state={dialog} onResolve={resolveDialog} />}
          {dialog?.kind === "prompt" && <PromptDialog state={dialog} onResolve={resolveDialog} />}
        </>
      )}
    </UiStateContext.Provider>
  );
}
