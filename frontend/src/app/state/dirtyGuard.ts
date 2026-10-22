import { collectionNavigationState, isConfigRenameNavigation, type NavigationLocation } from "../../shared/collectionTarget.ts";

export type DirtyGuardState = {
  dirty: boolean;
  pendingWrite: boolean;
  localDirty?: boolean;
  onDiscardLocal?: () => void;
};

export type NavigationBlockReason = "pending-write" | "dirty";

export function navigationBlockReason({
  dirty,
  pendingWrite,
  localDirty,
}: DirtyGuardState): NavigationBlockReason | null {
  if (pendingWrite) return "pending-write";
  return dirty || localDirty ? "dirty" : null;
}

export function shouldBlockNavigation(
  guard: DirtyGuardState,
  currentPath: string | NavigationLocation,
  nextPath: string | NavigationLocation,
  runtimeReturnPath?: string | NavigationLocation | null,
  action?: string,
) {
  const location = (path: string | NavigationLocation): NavigationLocation => {
    if (typeof path !== "string") return path;
    const [pathname, search] = path.split("?");
    return { pathname: pathname!, search };
  };
  // A confirmed rename replaces only the current entry's target metadata.
  if (isConfigRenameNavigation(location(currentPath), location(nextPath), action)) return false;
  const identity = (path: string | NavigationLocation) => {
    const current = location(path);
    // Version commits and collection selection stay within the same draft owner.
    return JSON.stringify([current.pathname, collectionNavigationState(current).collectionTarget.source ?? ""]);
  };
  if (!guard.pendingWrite && !guard.localDirty && (location(nextPath).pathname === "/runtime-config" ||
    (location(currentPath).pathname === "/runtime-config" && runtimeReturnPath && identity(nextPath) === identity(runtimeReturnPath)))) return false;
  if (identity(currentPath) !== identity(nextPath)) return navigationBlockReason(guard) !== null;
  if (location(currentPath).pathname !== "/collections" || (action !== "PUSH" && action !== "POP")) return false;
  const current = collectionNavigationState(location(currentPath)).collectionTarget;
  const next = collectionNavigationState(location(nextPath)).collectionTarget;
  const moving = action === "POP" || ["view", "entry", "category", "collection"].some(key => current[key] !== next[key]);
  return moving && Boolean(guard.pendingWrite || guard.localDirty);
}
