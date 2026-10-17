// 用递增版本和 AbortController 管理状态轮询，禁止旧请求覆盖新结果。
export type StatusRequest<T> = (signal: AbortSignal) => Promise<T>;

export function statusAfterFailure() {
  return null;
}

export const CONTROLLER_SECRET_CHANGE_EVENT = "mihomo-controller-secret-change";

type ControllerStatusLifecycleOptions = {
  request: () => Promise<void>;
  connectStreams: () => () => void;
  eventTarget: {
    addEventListener: (type: string, listener: EventListener) => void;
    removeEventListener: (type: string, listener: EventListener) => void;
  };
  schedule: (callback: () => void) => number;
  cancelSchedule: (timer: number) => void;
};

export function startControllerStatusLifecycle(options: ControllerStatusLifecycleOptions) {
  let active = true;
  let stopStreams: (() => void) | null = null;
  const replaceStreams = () => {
    stopStreams?.();
    stopStreams = options.connectStreams();
  };
  const handleSecretChange = () => {
    if (!active) return;
    replaceStreams();
    void options.request();
  };

  void options.request();
  replaceStreams();
  options.eventTarget.addEventListener(CONTROLLER_SECRET_CHANGE_EVENT, handleSecretChange);
  const timer = options.schedule(() => {
    if (active) void options.request();
  });

  return () => {
    if (!active) return;
    active = false;
    options.eventTarget.removeEventListener(CONTROLLER_SECRET_CHANGE_EVENT, handleSecretChange);
    options.cancelSchedule(timer);
    stopStreams?.();
    stopStreams = null;
  };
}

type StatusPublisher<T> = {
  success: (status: T) => void;
  failure: (error: unknown, report: boolean) => void;
};

export class StatusRequestController<T> {
  private version = 0;
  private active: AbortController | null = null;
  private disposed = false;
  private readonly request: StatusRequest<T>;
  private readonly publish: StatusPublisher<T>;

  constructor(request: StatusRequest<T>, publish: StatusPublisher<T>) {
    this.request = request;
    this.publish = publish;
  }

  async run(report = false) {
    // 新一轮请求先取消上一轮，并以版本号和 controller 身份双重约束发布结果。
    const version = ++this.version;
    this.active?.abort();
    const controller = new AbortController();
    this.active = controller;
    try {
      const status = await this.request(controller.signal);
      if (this.canPublish(version, controller)) this.publish.success(status);
    } catch (error) {
      if (this.canPublish(version, controller)) {
        this.publish.failure(error, report);
      }
    } finally {
      if (this.active === controller) this.active = null;
    }
  }

  dispose() {
    this.disposed = true;
    this.version += 1;
    this.active?.abort();
    this.active = null;
  }

  private canPublish(version: number, controller: AbortController) {
    return (
      !this.disposed &&
      !controller.signal.aborted &&
      version === this.version &&
      this.active === controller
    );
  }
}
