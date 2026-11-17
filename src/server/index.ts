import path from "node:path";
import { createApp } from "./app.js";

const { app } = await createApp({
  dataDir: path.resolve(process.env.SCREENSVR_DATA_DIR ?? "data"),
  photosDir: path.resolve(process.env.SCREENSVR_PHOTOS_DIR ?? "/photos"),
  secureCookies: process.env.SCREENSVR_SECURE_COOKIES === "true",
  trustProxy: process.env.SCREENSVR_TRUST_PROXY === "true",
  origin: process.env.SCREENSVR_ORIGIN,
  logger: true,
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void app.close().then(
      () => process.exit(0),
      (error) => {
        app.log.error(error);
        process.exit(1);
      },
    );
  });
}
await app.listen({
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 3000),
});
