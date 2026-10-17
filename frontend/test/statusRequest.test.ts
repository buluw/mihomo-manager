import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROLLER_SECRET_CHANGE_EVENT,
  StatusRequestController,
  startControllerStatusLifecycle,
} from "../src/app/statusRequest.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("an older status success cannot overwrite a newer failure", async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  const requests = [first, second];
  const published: string[] = [];
  let index = 0;
  const controller = new StatusRequestController(
    () => requests[index++].promise,
    {
      success: (status) => published.push(`success:${status}`),
      failure: () => published.push("failure"),
    },
  );

  const older = controller.run();
  const newer = controller.run();
  second.reject(new Error("latest request failed"));
  await newer;
  first.resolve("stale healthy status");
  await older;

  assert.deepEqual(published, ["failure"]);
});

test("disposing the status controller prevents every later state publication", async () => {
  const pending = deferred<string>();
  const published: string[] = [];
  const controller = new StatusRequestController(() => pending.promise, {
    success: (status) => published.push(status),
    failure: () => published.push("failure"),
  });

  const request = controller.run();
  controller.dispose();
  pending.resolve("late success");
  await request;

  assert.deepEqual(published, []);
});

test("a Secret change refreshes status and replaces the active Controller stream set", () => {
  const secretChanges = new EventTarget();
  const releasedStreams: number[] = [];
  const canceledTimers: number[] = [];
  let requests = 0;
  let connectedStreams = 0;
  let poll: (() => void) | null = null;

  const stop = startControllerStatusLifecycle({
    request: async () => {
      requests += 1;
    },
    connectStreams: () => {
      const streamSet = ++connectedStreams;
      return () => releasedStreams.push(streamSet);
    },
    eventTarget: secretChanges,
    schedule: (callback) => {
      poll = callback;
      return 42;
    },
    cancelSchedule: (timer) => canceledTimers.push(timer),
  });

  assert.equal(requests, 1);
  assert.equal(connectedStreams, 1);
  secretChanges.dispatchEvent(new Event(CONTROLLER_SECRET_CHANGE_EVENT));
  assert.equal(requests, 2);
  assert.equal(connectedStreams, 2);
  assert.deepEqual(releasedStreams, [1]);

  poll?.();
  assert.equal(requests, 3);
  stop();
  stop();
  assert.deepEqual(releasedStreams, [1, 2]);
  assert.deepEqual(canceledTimers, [42]);

  secretChanges.dispatchEvent(new Event(CONTROLLER_SECRET_CHANGE_EVENT));
  poll?.();
  assert.equal(requests, 3);
  assert.equal(connectedStreams, 2);
});

test("the active status failure preserves the caller report preference", async () => {
  const reports: boolean[] = [];
  const controller = new StatusRequestController(
    async () => {
      throw new Error("offline");
    },
    {
      success: assert.fail,
      failure: (_error, report) => reports.push(report),
    },
  );

  await controller.run(true);

  assert.deepEqual(reports, [true]);
});
