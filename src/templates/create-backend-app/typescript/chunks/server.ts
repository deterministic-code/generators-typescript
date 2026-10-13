import { once } from "node:events";
import { createServer } from "node:http";
import { {{appFnName}} } from "./{{appFileBase}}.js";

const port = Number(process.env.PORT ?? 4001);

const app = await {{appFnName}}();
const server = createServer(app);
server.listen(port);
await once(server, "listening");
console.log(`{{appName}} listening on http://localhost:${port}`);

const shutdown = async () => {
  server.close();
  await once(server, "close");
  console.log("{{appName}} stopped");
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
