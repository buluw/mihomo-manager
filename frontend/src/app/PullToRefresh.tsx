import { useEffect, useRef, useState, type ReactNode } from "react"
import { RefreshCw } from "lucide-react"

import { Spinner } from "@/components/ui/spinner"
import { PULL_REFRESH_THRESHOLD, registerPullRefresh } from "./pullRefreshGesture"

export function PullToRefresh({ children, onRefresh, refreshing, pathname }: {
  children: ReactNode
  onRefresh: () => Promise<void>
  refreshing: boolean
  pathname: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const busy = useRef(refreshing)
  busy.current = refreshing
  const [distance, setDistance] = useState(0)
  useEffect(() => {
    setDistance(0)
    const registration = registerPullRefresh(root.current!, {
      isRefreshing: () => busy.current,
      onRefresh,
      onDistance: setDistance,
    })
    return () => registration.dispose()
  }, [onRefresh, pathname])
  const offset = refreshing ? 40 : distance
  return (
    <div ref={root} className="relative h-full min-h-0 overflow-hidden" data-pull-refresh-root>
      {offset > 0 && <div role="status" aria-label={refreshing ? "正在刷新" : distance >= PULL_REFRESH_THRESHOLD ? "松开刷新" : "下拉刷新"}
        className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center text-muted-foreground md:hidden" style={{ height: offset }}>
        {refreshing ? <Spinner className="size-5" /> : <RefreshCw className="size-5" style={{ transform: "rotate(" + distance / PULL_REFRESH_THRESHOLD * 180 + "deg)" }} />}
      </div>}
      <div className="h-full min-h-0 transition-transform duration-150 motion-reduce:transition-none md:transform-none"
        style={{ transform: offset > 0 ? "translateY(" + offset + "px)" : undefined, transitionDuration: distance > 0 ? "0ms" : undefined }}>
        {children}
      </div>
    </div>
  )
}
