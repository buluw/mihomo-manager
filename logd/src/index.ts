import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { LogCollector } from "./collector.js";
import { createLogServer } from "./server.js";
import { LogStore } from "./store.js";

function positiveInt(name: string, fallback: number) {
  const raw = process.env[name];
  const value = raw == null ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

const dbPath = resolve(process.env.LOGD_DB_PATH || "../runtime/logs/mihomo-logs.sqlite");
await mkdir(dirname(dbPath), { recursive: true });
const store = new LogStore(dbPath, positiveInt("LOGD_DEFAULT_RETENTION_DAYS", 7));
store.purge();
const { server, publish } = createLogServer({ store });
const controllerLogLevel = process.env.LOGD_CONTROLLER_LOG_LEVEL === "debug" ? "debug" : "info";
const collector = new LogCollector({
  controllerUrl: process.env.MIHOMO_CONTROLLER_URL || "http://127.0.0.1:9090",
  level: controllerLogLevel,
  ...(process.env.MIHOMO_CONTROLLER_SECRET ? { secret: process.env.MIHOMO_CONTROLLER_SECRET } : {}),
  store,
  publish,
});
collector.start();
const cleanupTimer = setInterval(() => store.purge(), 60 * 60 * 1000);

const host = process.env.LOGD_HOST || "127.0.0.1";
const port = positiveInt("LOGD_PORT", 9082);
server.listen(port, host, () => process.stdout.write(`logd listening on ${host}:${port}\n`));

const shutdown = () => {
  clearInterval(cleanupTimer);
  collector.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
