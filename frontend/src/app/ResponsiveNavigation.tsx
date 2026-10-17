import { useEffect, useState, type ReactNode } from "react";
import {
  MoreHorizontal,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Route,
  Sun,
} from "lucide-react";
import { NavLink } from "react-router";

import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";
import type { Json } from "@/shared/types";
import { navigationItems, type NavigationItem } from "./navigation";

const navGroups = [
  { id: "runtime" as const, label: "运行" },
  { id: "config" as const, label: "配置" },
  { id: "diagnostic" as const, label: "诊断" },
].map((group) => ({
  label: group.label,
  items: navigationItems.filter((item) => item.group === group.id),
}));
const mobilePrimary = navigationItems.filter((item) => item.mobile === "primary");
const mobileMore = navigationItems.filter((item) => item.mobile === "more");
const settingsRoute = navigationItems.find((item) => item.id === "settings")!;

type ResponsiveNavigationProps = {
  children: ReactNode;
  currentRoute: NavigationItem;
  dirty: boolean;
  onRefresh: () => Promise<void>;
  pathname: string;
  refreshing: boolean;
  status: Json | null;
  statusError: boolean;
};

export function ResponsiveNavigation({
  children,
  currentRoute,
  dirty,
  onRefresh,
  pathname,
  refreshing,
  status,
  statusError,
}: ResponsiveNavigationProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const [moreOpen, setMoreOpen] = useState(false);
  const [sidebarExpanded, setSidebarExpanded] = useState(() =>
    window.matchMedia("(min-width: 1280px)").matches,
  );

  useEffect(() => setMoreOpen(false), [pathname]);

  const moreActive = mobileMore.some((item) => item.path === pathname);
  const closeMore = () => setMoreOpen(false);
  const online = status?.controller === true && !statusError;
  const coreLabel = statusError
    ? "Core 状态未知"
    : status === null
      ? "Core 检测中"
      : online
        ? "Core 运行中"
        : "Core 未连接";
  const versionLabel = String(status?.version || "-").split(" ")[0];
  const isDark = resolvedTheme === "dark";
  const toggleTheme = () => setTheme(isDark ? "light" : "dark");

  return (
    <div
      className={cn(
        "grid h-dvh overflow-hidden bg-background text-foreground",
        sidebarExpanded ? "md:grid-cols-[224px_minmax(0,1fr)]" : "md:grid-cols-[64px_minmax(0,1fr)]",
      )}
    >
      <aside className="hidden h-dvh flex-col border-r bg-sidebar p-2 md:flex">
        <div className={cn("flex h-10 items-center gap-2 px-2", !sidebarExpanded && "md:justify-center md:px-0")}>
          <Route aria-hidden className="size-6 shrink-0 text-foreground" />
          <span className={cn("text-sm font-semibold", !sidebarExpanded && "md:hidden")}>Mihomo Manager</span>
        </div>
        <nav className="mt-2 min-h-0 flex-1" aria-label="主导航">
          {navGroups.map((group, groupIndex) => (
            <div key={group.label} className={cn("mb-3", !sidebarExpanded && "md:mb-1")}>
              <div className={cn("h-6 px-2 text-[11px] font-medium text-muted-foreground", !sidebarExpanded && "md:hidden")}>{group.label}</div>
              {groupIndex > 0 && !sidebarExpanded && (
                <div className="hidden h-5 items-center justify-center md:flex"><span className="h-px w-5 bg-sidebar-border" /></div>
              )}
              <div className="flex flex-col gap-0.5">
                {group.items.map((item) => (
                  <Tooltip key={item.id} disabled={sidebarExpanded}>
                    <TooltipTrigger
                      render={
                        <NavLink
                          to={item.path}
                          end
                          onClick={closeMore}
                          className={({ isActive }) => cn(
                            "flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                            !sidebarExpanded && "md:justify-center md:px-0",
                            isActive && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
                          )}
                        />
                      }
                    >
                      <item.icon className="size-4 shrink-0" />
                      <span className={cn(!sidebarExpanded && "md:hidden")}>{item.label}</span>
                    </TooltipTrigger>
                    <TooltipContent>{item.label}</TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="shrink-0">
          <Separator className="mb-2" />
          <Tooltip disabled={sidebarExpanded}>
            <TooltipTrigger
              render={<div className={cn("flex h-8 items-center gap-2 px-2 text-xs text-muted-foreground", !sidebarExpanded && "md:justify-center md:px-0")} />}
            >
              <span className={cn("size-1.5 rounded-full", statusError ? "bg-destructive" : online ? "bg-status-success" : "bg-status-warning")} />
              <span className={cn(!sidebarExpanded && "md:hidden")}>{coreLabel}</span>
              <span className={cn("ml-auto font-mono text-[10px]", !sidebarExpanded && "md:hidden")}>{versionLabel}</span>
            </TooltipTrigger>
            <TooltipContent>{coreLabel} · {versionLabel}</TooltipContent>
          </Tooltip>
          <div className={cn("flex gap-1", !sidebarExpanded && "md:flex-col")}>
            <Tooltip disabled={sidebarExpanded}>
              <TooltipTrigger
                render={
                  <NavLink
                    to={settingsRoute.path}
                    end
                    onClick={closeMore}
                    className={({ isActive }) => cn(
                      "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                      !sidebarExpanded && "md:h-8 md:w-full md:flex-none md:justify-center md:px-0",
                      isActive && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
                    )}
                  />
                }
              >
                <settingsRoute.icon className="size-[18px] shrink-0" />
                <span className={cn(!sidebarExpanded && "md:hidden")}>{settingsRoute.label}</span>
              </TooltipTrigger>
              <TooltipContent>{settingsRoute.label}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={<Button variant="ghost" size="icon-sm" className={cn("size-8 shrink-0 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground", !sidebarExpanded && "md:w-full")} onClick={toggleTheme} />}
              >
                {isDark ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
                <span className="sr-only">切换明暗主题</span>
              </TooltipTrigger>
              <TooltipContent>切换明暗主题</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={<Button variant="ghost" size="icon-sm" className={cn("hidden size-8 shrink-0 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground md:inline-flex", !sidebarExpanded && "md:w-full")} onClick={() => setSidebarExpanded((current) => !current)} />}
              >
                {sidebarExpanded ? <PanelLeftClose className="size-[18px]" /> : <PanelLeftOpen className="size-[18px]" />}
                <span className="sr-only">{sidebarExpanded ? "收起侧栏" : "展开侧栏"}</span>
              </TooltipTrigger>
              <TooltipContent>{sidebarExpanded ? "收起侧栏" : "展开侧栏"}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </aside>

      <main className="flex h-dvh min-h-0 min-w-0 flex-col overflow-hidden">
        {!online && status !== null && <p role="status" className="shrink-0 px-4 py-1 text-xs text-status-warning md:hidden">{coreLabel}</p>}
        <div className="min-h-0 flex-1 overflow-hidden pb-[calc(64px+env(safe-area-inset-bottom))] md:pb-0">
          {children}
        </div>
      </main>

      <nav aria-label="移动端导航" className="fixed inset-x-0 bottom-0 grid h-[calc(64px+env(safe-area-inset-bottom))] grid-cols-5 border-t bg-background/96 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {mobilePrimary.map((item) => (
          <NavLink
            key={item.id}
            to={item.path}
            end
            onClick={closeMore}
            className={({ isActive }) => cn("flex min-h-11 flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors", isActive && "text-primary")}
          >
            <item.icon className="size-5" />{item.label}
          </NavLink>
        ))}
        <Drawer open={moreOpen} onOpenChange={setMoreOpen} showSwipeHandle>
          <DrawerTrigger
            render={<button type="button" aria-current={moreActive ? "page" : undefined} className={cn("flex min-h-11 flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors", moreActive && "text-primary")} />}
          >
            <MoreHorizontal className="size-5" />更多
          </DrawerTrigger>
          <DrawerContent className="[--drawer-inset:0px]">
            <DrawerHeader className="sr-only">
              <DrawerTitle>更多功能</DrawerTitle>
              <DrawerDescription>{currentRoute.label}{dirty ? " · 未保存" : ""}</DrawerDescription>
            </DrawerHeader>
            <div className="grid grid-cols-4 gap-2.5 px-3.5 pt-3 pb-[calc(16px+env(safe-area-inset-bottom))]">
              {mobileMore.map((item) => (
                <Button
                  key={item.id}
                  nativeButton={false}
                  render={<NavLink to={item.path} end onClick={closeMore} />}
                  variant={pathname === item.path ? "default" : "secondary"}
                  className="col-span-2 h-[82px] flex-col items-start justify-center gap-2 rounded-2xl px-4 py-3"
                >
                  <item.icon className="size-6" />{item.label}
                </Button>
              ))}
              <Tooltip>
                <TooltipTrigger render={<Button variant="secondary" size="icon" className="h-[82px] w-full rounded-2xl" aria-label="刷新当前页面" aria-busy={refreshing} disabled={refreshing} onClick={() => { closeMore(); void onRefresh() }} />}>
                  <RefreshCw className={cn("size-6", refreshing && "animate-spin")} />
                </TooltipTrigger>
                <TooltipContent>刷新当前页面</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger render={<Button variant="secondary" size="icon" className="h-[82px] w-full rounded-2xl" onClick={toggleTheme} aria-label={isDark ? "切换浅色主题" : "切换深色主题"} />}>
                  {isDark ? <Sun className="size-6" /> : <Moon className="size-6" />}
                </TooltipTrigger>
                <TooltipContent>{isDark ? "切换浅色主题" : "切换深色主题"}</TooltipContent>
              </Tooltip>
            </div>
          </DrawerContent>
        </Drawer>
      </nav>
    </div>
  );
}
