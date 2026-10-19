export type ProxyDelayPriority = "manual" | "batch";
export type ProxyDelayPhase = "queued" | "running";

type Probe = {
  identity: string;
  priority: ProxyDelayPriority;
  phase: ProxyDelayPhase;
  controller: AbortController;
  run: (signal: AbortSignal) => Promise<number>;
  promise: Promise<number>;
  resolve: (delay: number) => void;
  reject: (error: unknown) => void;
};

export class ProxyDelayScheduler {
  private readonly pending = new Map<string, Probe>();
  private readonly queue: Probe[] = [];
  private readonly onChange: (states: Record<string, ProxyDelayPhase>) => void;
  private running = 0;
  private disposed = false;

  constructor(onChange: (states: Record<string, ProxyDelayPhase>) => void = () => {}) {
    this.onChange = onChange;
  }

  request(identity: string, priority: ProxyDelayPriority, run: Probe["run"]): Promise<number> {
    if (this.disposed) return Promise.reject(new DOMException("测速会话已关闭", "AbortError"));
    const current = this.pending.get(identity);
    if (current) {
      if (priority === "manual") current.priority = "manual";
      return current.promise;
    }
    let resolve!: Probe["resolve"];
    let reject!: Probe["reject"];
    const promise = new Promise<number>((yes, no) => { resolve = yes; reject = no; });
    const probe: Probe = { identity, priority, phase: "queued", controller: new AbortController(), run, promise, resolve, reject };
    this.pending.set(identity, probe);
    this.queue.push(probe);
    this.publish();
    this.drain();
    return promise;
  }

  private publish() {
    this.onChange(Object.fromEntries([...this.pending].map(([identity, probe]) => [identity, probe.phase])));
  }

  private drain() {
    while (!this.disposed && this.running < 4 && this.queue.length) {
      const manual = this.queue.findIndex(probe => probe.priority === "manual");
      const [probe] = this.queue.splice(manual < 0 ? 0 : manual, 1);
      probe.phase = "running";
      this.running++;
      this.publish();
      void Promise.resolve().then(() => {
        probe.controller.signal.throwIfAborted();
        return probe.run(probe.controller.signal);
      }).then(delay => { this.finish(probe); probe.resolve(delay); }, error => { this.finish(probe); probe.reject(error); });
    }
  }

  private finish(probe: Probe) {
    this.running--;
    this.pending.delete(probe.identity);
    if (!this.disposed) { this.publish(); this.drain(); }
  }

  dispose() {
    this.disposed = true;
    const error = new DOMException("测速会话已关闭", "AbortError");
    for (const probe of this.pending.values()) { probe.controller.abort(error); probe.reject(error); }
    this.queue.length = 0;
    this.pending.clear();
    this.publish();
  }
}
