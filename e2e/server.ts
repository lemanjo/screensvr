import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createApp } from "../src/server/app.js";
import { temporaryDirectory } from "../tests/helpers.js";

const dataDir = await temporaryDirectory("screensvr-browser-");
const photosDir = path.join(dataDir, "photos");
await mkdir(path.join(photosDir, "family"), { recursive: true });
for (const [name, color] of [
  ["one.jpg", "#507850"],
  ["two.jpg", "#785050"],
]) {
  await writeFile(
    path.join(photosDir, "family", name),
    await sharp({
      create: { width: 800, height: 400, channels: 3, background: color },
    })
      .jpeg()
      .toBuffer(),
  );
}
const { app } = await createApp({ dataDir, photosDir });
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => rm(dataDir, { recursive: true, force: true }))
      .then(() => process.exit(0));
  });
}
await app.listen({ port: Number(process.env.PORT ?? 3100), host: "127.0.0.1" });
