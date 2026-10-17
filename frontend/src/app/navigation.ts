import {
  Boxes,
  Cable,
  CircleGauge,
  FileCog,
  FileSearch,
  ListTree,
  Network,
  Settings2,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";

export type PrimaryRouteId =
  | "overview"
  | "proxies"
  | "rules"
  | "connections"
  | "config-center"
  | "collections"
  | "runtime-config"
  | "logs"
  | "settings";

export type NavigationItem = {
  id: PrimaryRouteId;
  path: `/${PrimaryRouteId}`;
  label: string;
  group: "runtime" | "config" | "diagnostic" | null;
  mobile: "primary" | "more";
  icon: LucideIcon;
};

export const navigationItems: NavigationItem[] = [
  { id: "overview", path: "/overview", label: "概览", group: "runtime", mobile: "primary", icon: CircleGauge },
  { id: "proxies", path: "/proxies", label: "代理", group: "runtime", mobile: "primary", icon: Network },
  { id: "rules", path: "/rules", label: "规则", group: "runtime", mobile: "primary", icon: ListTree },
  { id: "connections", path: "/connections", label: "连接", group: "runtime", mobile: "more", icon: Cable },
  { id: "config-center", path: "/config-center", label: "编辑配置", group: "config", mobile: "primary", icon: FileCog },
  { id: "collections", path: "/collections", label: "代理集合", group: "config", mobile: "more", icon: Boxes },
  { id: "runtime-config", path: "/runtime-config", label: "运行配置", group: "config", mobile: "more", icon: FileSearch },
  { id: "logs", path: "/logs", label: "日志", group: "diagnostic", mobile: "more", icon: TerminalSquare },
  { id: "settings", path: "/settings", label: "设置", group: null, mobile: "more", icon: Settings2 },
];

export const compatibilityRedirects = [
  { path: "system", to: "/settings" },
  { path: "config/*", to: "/config-center" },
] as const;

export function navigationItemFromPath(pathname: string) {
  return navigationItems.find((item) => item.path === pathname) ?? null;
}

export function routeIdFromPath(pathname: string): PrimaryRouteId | null {
  return navigationItemFromPath(pathname)?.id ?? null;
}

export function redirectTargetForPath(pathname: string) {
  if (pathname === "/") return "/overview";
  if (pathname === "/system") return "/settings";
  if (pathname === "/config" || pathname.startsWith("/config/")) return "/config-center";
  return routeIdFromPath(pathname) ? null : "/overview";
}

export function isExactConfigTabPath(path: string, tabs: readonly string[]) {
  return tabs.some((tab) => path === `/config/${tab}`);
}
