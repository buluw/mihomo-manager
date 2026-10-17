import { isIP } from "node:net";
import { createSysinfoServer } from "./server.js";
import { CoreUpdates } from "./coreUpdate.js";
import { AccessGateway } from "./access/http.js";
import { WebUiUpdates } from "./webuiUpdate/service.js";
import { AutomaticUpdates } from "./webuiUpdate/policy.js";
import { WebUiUpdateApi } from "./webuiUpdate/http.js";

const host = process.env.SYSINFO_HOST ?? "127.0.0.1";
const port = Number(process.env.SYSINFO_PORT ?? 9083);
if (!isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("Invalid sysinfo listen configuration");
}
const coreUpdates = new CoreUpdates();
const webUiUpdates = new WebUiUpdates(undefined, { coreBusy: () => coreUpdates.busy });
await webUiUpdates.initialize();
const automaticUpdates = new AutomaticUpdates(webUiUpdates, coreUpdates);
await automaticUpdates.initialize();
const server = createSysinfoServer(undefined, undefined, coreUpdates, undefined, new AccessGateway(), new WebUiUpdateApi(webUiUpdates, automaticUpdates));
server.on("listening", () => automaticUpdates.start());
server.on("error", () => {
  console.error("Sysinfo could not listen.");
  process.exitCode = 1;
});
server.listen(port, host);
