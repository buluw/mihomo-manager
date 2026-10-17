// 为短操作提供最小动画时长和互斥执行状态，避免按钮视觉闪烁。
import { useCallback, useEffect, useRef, useState } from "react";

export function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function withMinimumSpin<T>(task: Promise<T>, duration = 460): Promise<T> {
  const [result] = await Promise.all([task, wait(duration)]);
  return result;
}

export function useAnimatedAction() {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(async <T,>(task: () => Promise<T>) => {
    if (mounted.current) setBusy(true);
    try {
      return await withMinimumSpin(task());
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);
  return { busy, run };
}
