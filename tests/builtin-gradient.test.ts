import { afterEach, beforeEach, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { createApp } from "../src/server/app.js";
import { validateSettings } from "../src/shared/contracts.js";
import { administrator, temporaryDirectory } from "./helpers.js";

let server: Awaited<ReturnType<typeof createApp>>;
let dataDir: string;

const variants = [
  {
    faceId: "builtin-gradient",
    faceName: "Color Drift",
    defaults: {
      colorOne: "#7865c9",
      colorTwo: "#e8a6b5",
      colorThree: "#78c5d6",
      clockColor: "#fffaf5",
      animate: true,
    },
  },
  {
    faceId: "builtin-gradient-dark",
    faceName: "Color Drift Night",
    defaults: {
      colorOne: "#171e3b",
      colorTwo: "#392541",
      colorThree: "#123b42",
      clockColor: "#e2e8f2",
      animate: true,
    },
  },
];

beforeEach(async () => {
  dataDir = await temporaryDirectory("screensvr-gradient-");
  server = await createApp({ dataDir });
});

afterEach(async () => {
  await server?.app.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

it.each(variants)(
  "preinstalls $faceName with valid defaults, sandboxed assets, and removal protection",
  async ({ faceId, faceName, defaults }) => {
    const headers = await administrator(server.app);
    const faces = (
      await server.app.inject({ url: "/api/faces", headers })
    ).json();
    const face = faces.find(
      (face: { manifest: { id: string } }) => face.manifest.id === faceId,
    );
    expect(face).toMatchObject({
      builtin: true,
      manifest: { name: faceName, version: "1.0.0" },
    });
    expect(validateSettings(face.manifest, {})).toEqual(defaults);
    for (const file of ["index.html", "style.css", "face.js"]) {
      const asset = await server.app.inject(`/faces/${faceId}/1.0.0/${file}`);
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["content-security-policy"]).toContain(
        "sandbox allow-scripts",
      );
    }
    expect(
      (
        await server.app.inject({
          method: "DELETE",
          url: `/api/faces/${faceId}`,
          headers,
        })
      ).statusCode,
    ).toBe(409);
  },
);

it.each(variants)(
  "adds $faceName to existing installations and preserves its display settings across restarts",
  async ({ faceId, defaults }) => {
    const headers = await administrator(server.app);
    // Model a database created before this variant was bundled.
    server.store.db.prepare("DELETE FROM faces WHERE id = ?").run(faceId);
    await server.app.close();
    server = await createApp({ dataDir });
    expect(server.store.face(faceId)?.builtin).toBe(true);

    const created = await server.app.inject({
      method: "POST",
      url: "/api/devices",
      headers,
      payload: {
        name: "Gradient",
        timezone: "Asia/Kathmandu",
        faceId,
      },
    });
    expect(created.statusCode).toBe(201);
    const { id, displayUrl } = created.json();
    const saved = await server.app.inject({
      method: "PATCH",
      url: `/api/devices/${id}`,
      headers,
      payload: {
        revision: 1,
        settings: {
          colorOne: "#112233",
          clockColor: "#ffffff",
          animate: false,
        },
      },
    });
    expect(saved.statusCode).toBe(200);
    await server.app.close();
    server = await createApp({ dataDir });

    expect(server.store.faces()).toHaveLength(8);
    expect(
      (await server.app.inject(`/api${displayUrl}/state`)).json(),
    ).toMatchObject({
      face: { id: faceId },
      timezone: "Asia/Kathmandu",
      revision: 2,
      settings: {
        ...defaults,
        colorOne: "#112233",
        clockColor: "#ffffff",
        animate: false,
      },
    });
  },
);
