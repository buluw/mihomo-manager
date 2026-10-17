import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react"
import { useLocation } from "react-router"

import { PageRefreshRegistry, type PageRefreshHandler } from "./pageRefreshRegistry"

type PageRefreshContextValue = {
  register: (handler: PageRefreshHandler) => () => void
  run: () => Promise<void>
}

const PageRefreshContext = createContext<PageRefreshContextValue | null>(null)

export function PageRefreshProvider({ children }: { children: ReactNode }) {
  const registry = useRef(new PageRefreshRegistry())
  const register = useCallback((handler: PageRefreshHandler) => registry.current.register(handler), [])
  const run = useCallback(() => registry.current.run(), [])
  const value = useMemo(() => ({ register, run }), [register, run])

  return <PageRefreshContext.Provider value={value}>{children}</PageRefreshContext.Provider>
}

function usePageRefreshContext() {
  const context = useContext(PageRefreshContext)
  if (!context) throw new Error("page refresh must be used within PageRefreshProvider")
  return context
}

export function useRegisterPageRefresh(handler: PageRefreshHandler) {
  const { register } = usePageRefreshContext()
  const { pathname } = useLocation()
  const ownerPath = useRef(pathname)
  useEffect(() => pathname === ownerPath.current ? register(handler) : undefined, [handler, register, pathname])
}

export function usePageRefreshController() {
  return usePageRefreshContext()
}
