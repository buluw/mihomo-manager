import { useCallback, useEffect, useRef, useState } from "react"

import { controllerApi } from "@/api/controllerClient"
import { useRegisterPageRefresh } from "@/app/pageRefresh"
import { LatestRequestController } from "@/shared/requestLifecycle"
import type { Json, Notify } from "@/shared/types"

import {
  CONNECTION_POLL_INTERVAL_MS,
  CONNECTIONS_PATH,
} from "./connectionLogic"
import {
  calculateConnectionRates,
  type ConnectionRate,
} from "./connectionViewModel"

type ConnectionSnapshot = { connections: Json[]; at: number }

export function useConnectionsPolling(notify: Notify) {
  const [connections, setConnections] = useState<Json[]>([])
  const [rates, setRates] = useState<Record<string, ConnectionRate>>({})
  const requests = useRef(new LatestRequestController())
  const previousSnapshot = useRef<ConnectionSnapshot | null>(null)

  const load = useCallback(async () => {
    const request = requests.current.begin()
    if (!request.isCurrent()) return

    try {
      const next = await controllerApi<Json>(CONNECTIONS_PATH, {
        signal: request.signal,
      })
      if (!request.isCurrent()) return

      const now = Date.now()
      const currentConnections = Array.isArray(next.connections)
        ? (next.connections as Json[])
        : []
      const previous = previousSnapshot.current
      setRates(
        calculateConnectionRates(
          previous?.connections,
          currentConnections,
          previous ? now - previous.at : 0
        )
      )
      previousSnapshot.current = { connections: currentConnections, at: now }
      setConnections(currentConnections)
    } catch (error) {
      if (request.isCurrent()) notify((error as Error).message, "error")
    } finally {
      request.finish()
    }
  }, [notify])

  useRegisterPageRefresh(load)

  useEffect(() => {
    const activeRequests = new LatestRequestController()
    requests.current = activeRequests
    previousSnapshot.current = null

    const refresh = () => void load()
    refresh()
    const timer = window.setInterval(refresh, CONNECTION_POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      activeRequests.dispose()
      previousSnapshot.current = null
    }
  }, [load])

  const cancelLoad = useCallback(() => requests.current.cancel(), [])

  return { connections, rates, load, cancelLoad }
}
