import { refreshAccess } from "./accessClient.ts";
import { SharedControllerStreams } from "./sharedControllerStreams.ts";

void refreshAccess();
const streams = new SharedControllerStreams();
const scope = self as unknown as { onconnect: (event: MessageEvent) => void };
scope.onconnect = (event) => streams.connect(event.ports[0]);
