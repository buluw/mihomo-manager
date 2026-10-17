import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useOutlet, useLocation, type Location } from "react-router";

import { toast } from "@/components/ui/toast";
import { useAnimatedAction } from "@/hooks/useAnimatedAction";
import type { Json, Notify } from "@/shared/types";
import { useControllerStatus } from "./controllerStatus";
import { navigationItemFromPath, navigationItems } from "./navigation";
import { usePageRefreshController } from "./pageRefresh";
import { ResponsiveNavigation } from "./ResponsiveNavigation";
import { PullToRefresh } from "./PullToRefresh";
import { useUiState } from "./state/uiState";

export type AppOutletContext = {
  status: Json | null;
  statusError: boolean;
  notify: Notify;
  refreshStatus: () => Promise<void>;
  runtimeReturnTo: Location | null;
};

export default function AppShell() {
  const { dirty } = useUiState();
  const location = useLocation();
  const currentRoute = navigationItemFromPath(location.pathname) ?? navigationItems[0]!;
  const { busy: refreshing, run: runRefresh } = useAnimatedAction();
  const { run: refreshPage } = usePageRefreshController();
  const refreshInFlight = useRef(false);
  const successToasts = useRef(new Map<string, { expiresAt: number; timer: number }>());

  const scheduleSuccessExpiry = useCallback(() => {
    for (const [id, entry] of successToasts.current) {
      window.clearTimeout(entry.timer);
      const remaining = entry.expiresAt - Date.now();
      if (remaining <= 0) {
        successToasts.current.delete(id);
        toast.close(id);
      } else {
        entry.timer = window.setTimeout(scheduleSuccessExpiry, remaining);
      }
    }
  }, []);

  useEffect(() => {
    window.addEventListener("focus", scheduleSuccessExpiry);
    document.addEventListener("visibilitychange", scheduleSuccessExpiry);
    return () => {
      window.removeEventListener("focus", scheduleSuccessExpiry);
      document.removeEventListener("visibilitychange", scheduleSuccessExpiry);
      for (const [id, entry] of successToasts.current) {
        window.clearTimeout(entry.timer);
        toast.close(id);
      }
      successToasts.current.clear();
    };
  }, [scheduleSuccessExpiry]);

  const notify: Notify = useCallback((message, kind = "ok") => {
    const id = toast.add({
      title: kind === "ok" ? "操作完成" : "操作失败",
      description: message,
      type: kind === "ok" ? "success" : "error",
      timeout: kind === "ok" ? 0 : 4_500,
      onClose: () => {
        const entry = successToasts.current.get(id);
        if (entry) window.clearTimeout(entry.timer);
        successToasts.current.delete(id);
      },
    });
    if (kind === "ok") {
      successToasts.current.set(id, { expiresAt: Date.now() + 4_500, timer: 0 });
      scheduleSuccessExpiry();
    }
  }, [scheduleSuccessExpiry]);

  const { status, statusError, refreshStatus, refreshStatusWithReport } = useControllerStatus(notify);
  const backgroundPage = useRef<{ location: Location; outlet: ReactNode } | null>(null);
  const viewingRuntime = location.pathname === "/runtime-config";
  const outlet = useOutlet({ status, statusError, notify, refreshStatus,
    runtimeReturnTo: viewingRuntime ? backgroundPage.current?.location ?? null : null } satisfies AppOutletContext);
  if (!viewingRuntime) backgroundPage.current = { location, outlet };
  const manualRefresh = useCallback(
    async () => {
      if (refreshInFlight.current) return;
      refreshInFlight.current = true;
      try {
        await runRefresh(async () => {
          await Promise.all([refreshStatusWithReport(), refreshPage()]);
        });
      } finally {
        refreshInFlight.current = false;
      }
    },
    [refreshPage, refreshStatusWithReport, runRefresh],
  );

  useEffect(() => {
    document.title = `${currentRoute.label} - Mihomo Manager`;
  }, [currentRoute.label, location.pathname]);

  return (
    <ResponsiveNavigation
      currentRoute={currentRoute}
      dirty={dirty}
      onRefresh={manualRefresh}
      pathname={location.pathname}
      refreshing={refreshing}
      status={status}
      statusError={statusError}
    >
      <PullToRefresh onRefresh={manualRefresh} refreshing={refreshing} pathname={location.pathname}>
      <div className="h-full min-h-0" hidden={viewingRuntime}>
        {viewingRuntime ? backgroundPage.current?.outlet : outlet}
      </div>
      {viewingRuntime && outlet}
      </PullToRefresh>
    </ResponsiveNavigation>
  );
}
