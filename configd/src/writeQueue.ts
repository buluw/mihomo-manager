// 所有文件写操作共享此 Promise 链，前序失败不阻断后续任务继续串行执行。
export class WriteQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    // 成功和失败都推进 tail；调用者收到原结果，而下一任务不会被前序失败短路。
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
