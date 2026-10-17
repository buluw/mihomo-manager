import { useCallback, useEffect, useRef, useState } from "react";

import { controllerApi, subscribeController } from "@/api/controllerClient";
import type { Json, Notify } from "@/shared/types";
import {
  StatusRequestController,
  startControllerStatusLifecycle,
  statusAfterFailure,
} from "./statusRequest";

const STATUS_POLL_INTERVAL = 10_000;

export function useControllerStatus(notify: Notify) {
  const [status, setStatus] = useState<Json | null>(null);
  const [statusError, setStatusError] = useState(false);
  const statusRequest = useRef<StatusRequestController<Json> | null>(null);

  const runStatusRequest = useCallback(
    (report = false) => statusRequest.current?.run(report) ?? Promise.resolve(),
    [],
  );
  const refreshStatus = useCallback(() => runStatusRequest(false), [runStatusRequest]);
  const refreshStatusWithReport = useCallback(() => runStatusRequest(true), [runStatusRequest]);

  useEffect(() => {
    const controller = new StatusRequestController<Json>(
      async (signal) => {
        const [version, configs, connections] = await Promise.all([
          controllerApi<Json>("/version", { signal }),
          controllerApi<Json>("/configs", { signal }),
          controllerApi<Json>("/connections", { signal }),
        ]);
        return {
          controller: true,
          version: version.version || version.meta,
          mode: configs.mode,
          configs,
          connections: connections.connections?.length || 0,
        };
      },
      {
        success: (next) => {
          setStatus((current) => ({ ...current, ...next }));
          setStatusError(false);
        },
        failure: (error, report) => {
          setStatus(statusAfterFailure());
          setStatusError(true);
          if (report) notify((error as Error).message, "error");
        },
      },
    );
    statusRequest.current = controller;

    const stopLifecycle = startControllerStatusLifecycle({
      request: () => controller.run(),
      connectStreams: () => {
        const stopTraffic = subscribeController<Json>(
          "/traffic",
          (traffic) => setStatus((current) => ({ ...current, traffic })),
          (trafficConnected) => setStatus((current) => ({ ...current, trafficConnected })),
        );
        const stopMemory = subscribeController<Json>(
          "/memory",
          (memory) => setStatus((current) => ({ ...current, memory: memory.inuse || 0 })),
          (memoryConnected) => setStatus((current) => ({ ...current, memoryConnected })),
        );
        return () => {
          stopTraffic();
          stopMemory();
        };
      },
      eventTarget: window,
      schedule: (callback) => window.setInterval(callback, STATUS_POLL_INTERVAL),
      cancelSchedule: (timer) => window.clearInterval(timer),
    });

    return () => {
      stopLifecycle();
      controller.dispose();
      if (statusRequest.current === controller) statusRequest.current = null;
    };
  }, [notify]);

  return { status, statusError, refreshStatus, refreshStatusWithReport };
}
