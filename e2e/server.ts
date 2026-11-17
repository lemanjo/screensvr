import { rm } from "node:fs/promises";
import { createApp } from "../src/server/app.js";
import { temporaryDirectory } from "../tests/helpers.js";

const dataDir = await temporaryDirectory("screensvr-browser-");
const { app } = await createApp({ dataDir });
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => rm(dataDir, { recursive: true, force: true }))
      .then(() => process.exit(0));
  });
}
await app.listen({ port: Number(process.env.PORT ?? 3100), host: "127.0.0.1" });
