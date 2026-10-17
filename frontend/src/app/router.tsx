import type { ComponentType, ReactNode } from "react";
import { createBrowserRouter, Navigate, useOutletContext } from "react-router";

import AppShell, { type AppOutletContext } from "@/app/AppShell";
import {
  compatibilityRedirects,
  navigationItems,
  type PrimaryRouteId,
} from "@/app/navigation";
import { PageRefreshProvider } from "@/app/pageRefresh";
import { UiStateProvider } from "@/app/state/UiStateProvider";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { ConfigCenterPage } from "@/features/config-center/ConfigCenterPage";
import { RuntimeConfigPage } from "@/features/config-center/RuntimeConfigPage";
import { Connections } from "@/features/connections/Connections";
import { Logs } from "@/features/logs/Logs";
import { Dashboard } from "@/features/overview/Dashboard";
import { Collections } from "@/features/providers/Collections";
import { Proxies } from "@/features/proxies/Proxies";
import { Rules } from "@/features/rules/Rules";
import { SystemPage } from "@/features/system/SystemPage";
import { AccessGate } from "@/features/access/AccessGate";

const THEME_STORAGE_KEY = "mihomo-manager-theme";
const LEGACY_THEME_STORAGE_KEYS = ["mihomo-theme"] as const;

function Root() {
  return (
    <ThemeProvider
      storageKey={THEME_STORAGE_KEY}
      legacyStorageKeys={LEGACY_THEME_STORAGE_KEYS}
    >
      <UiStateProvider>
        <TooltipProvider delay={200}>
          <PageRefreshProvider>
            <Toaster>
              <AccessGate><AppShell /></AccessGate>
            </Toaster>
          </PageRefreshProvider>
        </TooltipProvider>
      </UiStateProvider>
    </ThemeProvider>
  );
}

type NotifyPage = ComponentType<Pick<AppOutletContext, "notify">>;
type StatusPage = ComponentType<
  Omit<AppOutletContext, "refreshStatus" | "runtimeReturnTo"> & {
    onRefresh: AppOutletContext["refreshStatus"];
  }
>;

function NotifyRoute({ Page }: { Page: NotifyPage }) {
  const { notify } = useOutletContext<AppOutletContext>();
  return <Page notify={notify} />;
}

function StatusRoute({ Page }: { Page: StatusPage }) {
  const context = useOutletContext<AppOutletContext>();
  return (
    <Page
      status={context.status}
      statusError={context.statusError}
      notify={context.notify}
      onRefresh={context.refreshStatus}
    />
  );
}

const primaryRouteElements = {
  overview: <StatusRoute Page={Dashboard} />,
  proxies: <NotifyRoute Page={Proxies} />,
  rules: <NotifyRoute Page={Rules} />,
  connections: <NotifyRoute Page={Connections} />,
  "config-center": <NotifyRoute Page={ConfigCenterPage} />,
  collections: <NotifyRoute Page={Collections} />,
  "runtime-config": <NotifyRoute Page={RuntimeConfigPage} />,
  logs: <NotifyRoute Page={Logs} />,
  settings: <StatusRoute Page={SystemPage} />,
} satisfies Record<PrimaryRouteId, ReactNode>;

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Root />,
    children: [
      { index: true, element: <Navigate to="/overview" replace /> },
      ...navigationItems.map((item) => ({
        path: item.path.slice(1),
        element: primaryRouteElements[item.id],
      })),
      ...compatibilityRedirects.map((redirect) => ({
        path: redirect.path,
        element: <Navigate to={redirect.to} replace />,
      })),
      { path: "*", element: <Navigate to="/overview" replace /> },
    ],
  },
]);
