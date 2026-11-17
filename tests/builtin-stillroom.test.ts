import { afterEach, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { createApp } from "../src/server/app.js";
import { validateSettings } from "../src/shared/contracts.js";
import { administrator, temporaryDirectory } from "./helpers.js";

let server: Awaited<ReturnType<typeof createApp>>;
let directory: string;
beforeEach(async () => {
  directory = await temporaryDirectory("screensvr-stillroom-");
  server = await createApp({ dataDir: directory });
});
afterEach(async () => {
  await server.app.close();
  await rm(directory, { recursive: true, force: true });
});

it("bundles Stillroom with a typed temperature input, dark defaults, and a licensed local font", async () => {
  const face = server.store.face("builtin-stillroom")!;
  expect(face).toMatchObject({
    builtin: true,
    manifest: {
      schemaVersion: 2,
      version: "1.0.0",
      name: "Stillroom",
      inputs: [
        { key: "roomTemperature", type: "number", quantity: "temperature" },
      ],
    },
  });
  expect(validateSettings(face.manifest, {})).toEqual({
    background: "#101615",
    clockColor: "#c9c4b8",
    accent: "#98aa9a",
    format: "24",
    showDate: true,
    roomLabel: "In this room",
    motion: true,
  });
  for (const file of [
    "index.html",
    "face.js",
    "style.css",
    "assets/OFL.txt",
    "assets/FONT.txt",
    "assets/InstrumentSerif-Regular.ttf",
  ]) {
    const response = await server.app.inject(
      `/faces/builtin-stillroom/1.0.0/${file}`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toContain(
      "connect-src 'none'",
    );
    expect(response.headers["access-control-allow-origin"]).toBe("*");
  }
  const font = await server.app.inject(
    "/faces/builtin-stillroom/1.0.0/assets/InstrumentSerif-Regular.ttf",
  );
  expect(font.headers["content-type"]).toContain("font/ttf");
  expect(createHash("sha256").update(font.rawPayload).digest("hex")).toBe(
    "498efd461f6ddfcb7a111bf9a565709d2085d48201d501ead960d93e84ffbb88",
  );
  const license = await server.app.inject(
    "/faces/builtin-stillroom/1.0.0/assets/OFL.txt",
  );
  expect(license.body).toContain("SIL OPEN FONT LICENSE");
  const headers = await administrator(server.app);
  expect(
    (
      await server.app.inject({
        method: "DELETE",
        url: "/api/faces/builtin-stillroom",
        headers,
      })
    ).statusCode,
  ).toBe(409);
});

it("adds Stillroom to existing installations and preserves customized settings after restart", async () => {
  const headers = await administrator(server.app);
  server.store.db
    .prepare("DELETE FROM faces WHERE id = 'builtin-stillroom'")
    .run();
  await server.app.close();
  server = await createApp({ dataDir: directory });
  expect(server.store.face("builtin-stillroom")?.builtin).toBe(true);
  const created = await server.app.inject({
    method: "POST",
    url: "/api/devices",
    headers,
    payload: {
      name: "Quiet room",
      timezone: "Europe/Helsinki",
      faceId: "builtin-stillroom",
    },
  });
  expect(created.statusCode).toBe(201);
  const id: string = created.json().id;
  expect(server.states.state(id)!.data.roomTemperature).toMatchObject({
    status: "unbound",
    value: null,
  });
  const update = await server.app.inject({
    method: "PATCH",
    url: `/api/devices/${id}`,
    headers,
    payload: {
      revision: 1,
      settings: { roomLabel: "Living room", motion: false, format: "12" },
    },
  });
  expect(update.statusCode).toBe(200);
  await server.app.close();
  server = await createApp({ dataDir: directory });
  expect(server.states.state(id)).toMatchObject({
    face: { id: "builtin-stillroom" },
    timezone: "Europe/Helsinki",
    settings: { roomLabel: "Living room", motion: false, format: "12" },
    data: { roomTemperature: { status: "unbound" } },
  });
});
