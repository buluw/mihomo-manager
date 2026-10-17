import type { ReactNode } from "react";

export function ProxyMobileSplit({ groups, nodes }: { groups: ReactNode; nodes: ReactNode }) {
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)] lg:grid-cols-[204px_minmax(0,1fr)] lg:gap-3">
      <div className="hidden min-h-0 overflow-hidden lg:block">
        {groups}
      </div>
      <div className="min-h-0 min-w-0 overflow-hidden">
        {nodes}
      </div>
    </div>
  );
}
