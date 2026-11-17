import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm, readdir } from "node:fs/promises";
import { createApp } from "../src/server/app.js";
import {
  administrator,
  faceZip,
  testManifest,
  temporaryDirectory,
  upload,
  zip,
} from "./helpers.js";

let server: Awaited<ReturnType<typeof createApp>>;
let dataDir: string;
beforeEach(async () => {
  dataDir = await temporaryDirectory("screensvr-test-");
  server = await createApp({ dataDir });
});
afterEach(async () => {
  await server?.app.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe("administrator security", () => {
  it("requires setup, validates passwords, and protects administrator routes", async () => {
    const { app, store } = server;
    expect((await app.inject("/api/auth/status")).json()).toEqual({
      configured: false,
      authenticated: false,
    });
    expect((await app.inject("/api/devices")).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/setup",
          payload: { password: "short" },
        })
      ).statusCode,
    ).toBe(400);
    const headers = await administrator(app);
    expect(store.getMeta("password")).not.toContain("a-long-test-password");
    expect(
      (await app.inject({ url: "/api/faces", headers })).json(),
    ).toHaveLength(5);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/setup",
          payload: { password: "another-long-password" },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/devices",
          headers: { cookie: headers.cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "POST", url: "/api/auth/logout", headers }))
        .statusCode,
    ).toBe(200);
    expect((await app.inject({ url: "/api/faces", headers })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { password: "wrong-password-long" },
        })
      ).statusCode,
    ).toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "a-long-test-password" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers["set-cookie"]).toContain("HttpOnly");
    expect(login.headers["set-cookie"]).toContain("SameSite=Strict");
  });
  it("rejects cross-origin setup and rate-limits password attempts", async () => {
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: "/api/auth/setup",
          headers: { origin: "https://evil.invalid" },
          payload: { password: "a-long-test-password" },
        })
      ).statusCode,
    ).toBe(403);
    for (let i = 0; i < 5; i++)
      await server.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "wrong-long-password" },
      });
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { password: "wrong-long-password" },
        })
      ).statusCode,
    ).toBe(429);
  });
  it("allows only one concurrent initial setup", async () => {
    const responses = await Promise.all(
      Array.from({ length: 2 }, () =>
        server.app.inject({
          method: "POST",
          url: "/api/auth/setup",
          payload: { password: "a-long-test-password" },
        }),
      ),
    );
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });
});

describe("devices", () => {
  it("keeps face assignments and settings independent across displays", async () => {
    const { app } = server;
    const headers = await administrator(app);
    const ids: string[] = [];
    for (const name of ["Hallway", "Study"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/devices",
        headers,
        payload: { name, timezone: "UTC", faceId: "builtin-digital" },
      });
      ids.push(response.json().id);
    }
    await app.inject({
      method: "PATCH",
      url: `/api/devices/${ids[0]}`,
      headers,
      payload: {
        revision: 1,
        faceId: "builtin-analog",
        settings: { caption: "Just the hallway." },
      },
    });
    const devices = (await app.inject({ url: "/api/devices", headers })).json();
    expect(
      devices.find((device: { id: string }) => device.id === ids[0]),
    ).toMatchObject({
      faceId: "builtin-analog",
      revision: 2,
      settings: { caption: "Just the hallway." },
    });
    expect(
      devices.find((device: { id: string }) => device.id === ids[1]),
    ).toMatchObject({
      faceId: "builtin-digital",
      revision: 1,
      settings: { caption: "Be here, now." },
    });
  });
  it("serves read-only displays at permanent URLs and validates administrator changes", async () => {
    const { app } = server;
    const headers = await administrator(app);
    const create = await app.inject({
      method: "POST",
      url: "/api/devices",
      headers,
      payload: { name: "Olohuone", timezone: "UTC", faceId: "builtin-digital" },
    });
    expect(create.statusCode).toBe(201);
    const { id, displayUrl } = create.json();
    expect(displayUrl).toBe("/display/olohuone");
    expect(
      (await app.inject("/api/display/olohuone/state")).json(),
    ).toMatchObject({ id, displayUrl, name: "Olohuone" });
    // Old UUID bookmarks continue to resolve to the same display.
    expect(
      (await app.inject(`/api/display/${id}/state`)).json().displayUrl,
    ).toBe(displayUrl);
    expect((await app.inject("/api/devices")).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/devices/${id}`,
          payload: { revision: 1, name: "Unauthorized" },
        })
      ).statusCode,
    ).toBe(401);
    const save = (payload: object) =>
      app.inject({
        method: "PATCH",
        url: `/api/devices/${id}`,
        headers,
        payload,
      });
    expect(
      (await save({ revision: 1, settings: { caption: "A new mood" } })).json()
        .revision,
    ).toBe(2);
    expect((await save({ revision: 1, name: "Stale" })).statusCode).toBe(409);
    expect(
      (await save({ revision: 2, settings: { unknown: true } })).statusCode,
    ).toBe(400);
    expect(
      (await save({ revision: 2, timezone: "Not/A_Timezone" })).statusCode,
    ).toBe(400);
    expect(
      (await save({ revision: 2, faceId: "builtin-analog" })).json().settings
        .caption,
    ).toBe("Make time for less.");
    expect(
      (await save({ revision: 3, name: "Renamed living room" })).json(),
    ).toMatchObject({ name: "Renamed living room", displayUrl, revision: 4 });
    expect(
      (await app.inject({ url: "/api/devices", headers })).json()[0],
    ).toMatchObject({ displayUrl });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/devices/${id}/pairing`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/devices/${id}`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject("/api/display/olohuone/state")).statusCode).toBe(
      404,
    );
    expect((await app.inject("/api/display/olohuone/events")).statusCode).toBe(
      404,
    );
  });
  it("normalizes names and gives duplicate URLs deterministic, unique suffixes", async () => {
    const headers = await administrator(server.app);
    for (const [name, slug] of [
      ["Olohuone", "olohuone"],
      ["Olohuone!", "olohuone-2"],
      ["Olohuone 2", "olohuone-2-2"],
      ["OLOHUONE", "olohuone-3"],
      ["  Keittiö & työhuone  ", "keittio-tyohuone"],
      ["!!!", "display"],
      ["🌙", "display-2"],
    ]) {
      const response = await server.app.inject({
        method: "POST",
        url: "/api/devices",
        headers,
        payload: { name, timezone: "UTC", faceId: "builtin-digital" },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().displayUrl).toBe(`/display/${slug}`);
      expect(
        (await server.app.inject(`/api/display/${slug}/state`)).json().name,
      ).toBe(name.trim());
    }
  });
  it("persists assignments and authentication across restarts", async () => {
    const headers = await administrator(server.app);
    await server.app.inject({
      method: "POST",
      url: "/api/devices",
      headers,
      payload: {
        name: "Persistent",
        timezone: "Europe/Berlin",
        faceId: "builtin-analog",
      },
    });
    await server.app.close();
    server = await createApp({ dataDir });
    expect(
      (await server.app.inject({ url: "/api/devices", headers })).json()[0],
    ).toMatchObject({
      name: "Persistent",
      displayUrl: "/display/persistent",
      faceId: "builtin-analog",
      timezone: "Europe/Berlin",
    });
  });
});

describe("ZIP faces", () => {
  it("installs immutable packages, serves sandboxed assets, and prevents removal while assigned", async () => {
    const { app } = server;
    const headers = await administrator(app);
    expect((await upload(app, headers, faceZip())).statusCode).toBe(201);
    const asset = await app.inject("/faces/test-face/1.0.0/index.html");
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-security-policy"]).toContain(
      "sandbox allow-scripts",
    );
    expect(asset.headers["content-security-policy"]).toContain(
      "connect-src 'none'",
    );
    expect(asset.headers["content-security-policy"]).not.toContain(
      "allow-same-origin",
    );
    expect(asset.headers["access-control-allow-origin"]).toBe("*");
    expect((await upload(app, headers, faceZip())).statusCode).toBe(409);
    const created = await app.inject({
      method: "POST",
      url: "/api/devices",
      headers,
      payload: { name: "Test", timezone: "UTC", faceId: "test-face" },
    });
    expect(created.statusCode).toBe(201);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/faces/test-face",
          headers,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/faces/builtin-digital",
          headers,
        })
      ).statusCode,
    ).toBe(409);
    await app.inject({
      method: "DELETE",
      url: `/api/devices/${created.json().id}`,
      headers,
    });
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/faces/test-face",
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject("/faces/test-face/1.0.0/index.html")).statusCode,
    ).toBe(404);
  });
  it.each([
    ["traversal", () => zip([{ name: "../escaped.txt", data: "bad" }])],
    ["absolute paths", () => zip([{ name: "/escaped.txt", data: "bad" }])],
    [
      "symlinks",
      () => zip([{ name: "linked", data: "/etc/passwd", mode: 0o120777 }]),
    ],
    [
      "duplicate paths",
      () =>
        zip([
          { name: "index.html", data: "" },
          { name: "INDEX.html", data: "" },
        ]),
    ],
    [
      "excessive entries",
      () =>
        zip(
          Array.from({ length: 251 }, (_, i) => ({
            name: `file-${i}.txt`,
            data: "",
          })),
        ),
    ],
    [
      "missing entry point",
      () =>
        zip([{ name: "manifest.json", data: JSON.stringify(testManifest) }]),
    ],
    ["invalid JSON", () => zip([{ name: "manifest.json", data: "not JSON" }])],
    [
      "incompatible protocol",
      () => faceZip({ ...testManifest, schemaVersion: 2 }),
    ],
    ["reserved IDs", () => faceZip({ ...testManifest, id: "builtin-custom" })],
    ["non-ZIP data", () => Buffer.from("not a ZIP")],
    [
      "oversized expanded file",
      () =>
        zip([
          {
            name: "big.txt",
            data: Buffer.alloc(10 * 1024 * 1024 + 1),
            deflate: true,
          },
        ]),
    ],
    [
      "oversized total expansion",
      () =>
        zip(
          Array.from({ length: 6 }, (_, i) => ({
            name: `big-${i}.txt`,
            data: Buffer.alloc(9 * 1024 * 1024),
            deflate: true,
          })),
        ),
    ],
    [
      "corrupted checksums",
      () => {
        const buffer = zip([{ name: "file.txt", data: "original" }]);
        buffer[30 + "file.txt".length] ^= 1;
        return buffer;
      },
    ],
  ])("rejects %s and cleans up staging files", async (_name, make) => {
    const headers = await administrator(server.app);
    const response = await upload(server.app, headers, make());
    expect(response.statusCode).toBe(400);
    expect(await readdir(`${dataDir}/faces`)).toEqual([]);
    expect(
      (await server.app.inject({ url: "/api/faces", headers })).json(),
    ).toHaveLength(5);
  });
  it("limits incoming ZIP size", async () => {
    const headers = await administrator(server.app);
    expect(
      (await upload(server.app, headers, Buffer.alloc(10 * 1024 * 1024 + 1)))
        .statusCode,
    ).toBe(413);
  });
  it("persists installed assets and rejects concurrent replacement without overwriting", async () => {
    const headers = await administrator(server.app);
    const responses = await Promise.all([
      upload(server.app, headers, faceZip()),
      upload(server.app, headers, faceZip()),
    ]);
    expect(
      responses.filter((response) => response.statusCode === 201),
    ).toHaveLength(1);
    expect(
      responses.filter((response) => response.statusCode >= 400),
    ).toHaveLength(1);
    await server.app.close();
    server = await createApp({ dataDir });
    expect(
      (await server.app.inject("/faces/test-face/1.0.0/index.html")).statusCode,
    ).toBe(200);
    expect(
      (await server.app.inject("/faces/test-face/2.0.0/index.html")).statusCode,
    ).toBe(404);
    expect(
      (await server.app.inject({ url: "/api/faces", headers })).json(),
    ).toHaveLength(6);
  });
});
