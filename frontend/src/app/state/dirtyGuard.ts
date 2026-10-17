import { collectionNavigationState, isConfigRenameNavigation, type NavigationLocation } from "../../shared/collectionTarget.ts";

export type DirtyGuardState = {
  dirty: boolean;
  pendingWrite: boolean;
};

export type NavigationBlockReason = "pending-write" | "dirty";

export function navigationBlockReason({
  dirty,
  pendingWrite,
}: DirtyGuardState): NavigationBlockReason | null {
  if (pendingWrite) return "pending-write";
  return dirty ? "dirty" : null;
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
  if (!guard.pendingWrite && (location(nextPath).pathname === "/runtime-config" ||
    (location(currentPath).pathname === "/runtime-config" && runtimeReturnPath && identity(nextPath) === identity(runtimeReturnPath)))) return false;
  return identity(currentPath) !== identity(nextPath) && navigationBlockReason(guard) !== null;
}
