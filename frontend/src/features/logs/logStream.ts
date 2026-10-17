// 日志页面控制器负责显示映射、暂停队列和发布反馈。
import { LogEventStream, type LogStreamState, type LogStreamSocket } from "../../api/logClient.ts";
import { mergeLogEntries, type LogEntry } from "./logEntries.ts";
export type LogConnection = LogStreamState;

type LogPublisher = {
  entries: (events: LogEntry[]) => void;
  queued: (count: number) => void;
  connection: (connection: LogConnection) => void;
  error: (error: unknown) => void;
};

export class LogStreamController {
  private disposed = false;
  private paused = false;
  private queue: LogEntry[] = [];
  private readonly publish: LogPublisher;
  private readonly stream: LogEventStream;

  constructor(publish: LogPublisher, reconnectDelay?: number,
    createSocket?: (path: string) => LogStreamSocket, openTimeout?: number) {
    this.publish = publish;
    this.stream = new LogEventStream({
      connection: publish.connection,
      invalidEvent: () => publish.error(new Error("Controller 返回了无法解析的日志事件")),
      entries: (events) => {
        const entries = mergeLogEntries([], events.map((entry) => ({
          ...entry,
          receivedAt: new Date(entry.timestamp || Date.now()).toLocaleTimeString([], {
            hour: "2-digit", minute: "2-digit", second: "2-digit",
          }),
        })));
        if (!entries.length) return;
        if (this.paused) {
          this.queue = mergeLogEntries(this.queue, entries);
          this.publish.queued(this.queue.length);
        } else this.publish.entries(entries);
      },
    }, reconnectDelay, createSocket, openTimeout);
  }

  start() { this.stream.start(); }

  setPaused(paused: boolean) {
    if (this.disposed || this.paused === paused) return;
    this.paused = paused;
    // 恢复时一次发布有界队列，保持暂停期间的原生事件顺序。
    if (!paused && this.queue.length > 0) {
      const queued = this.queue;
      this.queue = [];
      this.publish.queued(0);
      this.publish.entries(queued);
    }
  }

  clearQueue() {
    this.queue = [];
    this.publish.queued(0);
  }

  restart() { this.stream.restart(); }

  dispose() {
    this.disposed = true;
    this.stream.dispose();
    this.queue = [];
  }
}
