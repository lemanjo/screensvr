import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdir,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createApp } from "../src/server/app.js";
import {
  MountedFolder,
  folderSchema,
} from "../src/server/integrations/mounted-folder.js";
import { manifestSchema } from "../src/shared/contracts.js";
import {
  datumSchema,
  type PhotoValue,
  type Source,
} from "../src/shared/face-data.js";
import { administrator, temporaryDirectory, testManifest } from "./helpers.js";

describe("mounted photos and scoped image delivery", () => {
  let directory: string;
  let photosDir: string;
  let server: Awaited<ReturnType<typeof createApp>>;
  let headers: Record<string, string>;
  let integrationId: string;
  let deviceId: string;
  let sources: Source[];
  const image = () =>
    sharp({
      create: { width: 800, height: 400, channels: 3, background: "#507850" },
    })
      .jpeg()
      .toBuffer();
  beforeEach(async () => {
    directory = await temporaryDirectory("screensvr-photos-");
    photosDir = path.join(directory, "photos");
    await mkdir(path.join(photosDir, "family", "nested"), { recursive: true });
    await mkdir(path.join(photosDir, "other"), { recursive: true });
    await mkdir(path.join(photosDir, ".private"), { recursive: true });
    const bytes = await image();
    await writeFile(path.join(photosDir, "family", "one.jpg"), bytes);
    await writeFile(path.join(photosDir, "family", "nested", "two.jpg"), bytes);
    await writeFile(path.join(photosDir, "other", "secret.jpg"), bytes);
    await writeFile(path.join(photosDir, ".private", "hidden.jpg"), bytes);
    await writeFile(path.join(photosDir, "family", "ignored.svg"), "<svg/>");
    await writeFile(path.join(directory, "outside.jpg"), bytes);
    await symlink(
      path.join(directory, "outside.jpg"),
      path.join(photosDir, "family", "link.jpg"),
    );
    await symlink(
      path.join(photosDir, "other"),
      path.join(photosDir, "family", "linked"),
    );
    server = await createApp({
      dataDir: path.join(directory, "data"),
      photosDir,
    });
    headers = await administrator(server.app);
    const result = await server.app.inject({
      method: "POST",
      url: "/api/integrations",
      headers,
      payload: { type: "mounted-folder", name: "Family", folder: "family" },
    });
    expect(result.statusCode).toBe(201);
    integrationId = result.json().id;
    await expect
      .poll(
        () =>
          server.integrations.list().find((item) => item.id === integrationId)
            ?.status,
      )
      .toBe("connected");
    sources = (
      await server.app.inject({
        url: `/api/integrations/${integrationId}/sources?type=image`,
        headers,
      })
    ).json().sources;
    deviceId = (
      await server.app.inject({
        method: "POST",
        url: "/api/devices",
        headers,
        payload: { name: "Photos", timezone: "UTC", faceId: "builtin-photos" },
      })
    ).json().id;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await server?.app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function bind(source: Source, revision = 1) {
    const response = await server.app.inject({
      method: "PATCH",
      url: `/api/devices/${deviceId}`,
      headers,
      payload: {
        revision,
        bindings: { photos: { integrationId, sourceId: source.id } },
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json().data.photos.value as PhotoValue;
  }
  const root = () => sources.find((source) => source.label === "All photos /")!;
  it("discovers folders and individual files, excluding hidden files, symlinks and unsupported formats", async () => {
    expect(sources.map((source) => source.label).sort()).toEqual([
      "All photos /",
      "nested /",
      "nested/two.jpg",
      "one.jpg",
    ]);
    expect(sources.every((source) => /^[a-f0-9]{64}$/.test(source.id))).toBe(
      true,
    );
    const listed = server.integrations.list()[0];
    expect(listed).toMatchObject({
      type: "mounted-folder",
      folder: "family",
      hasCredentials: false,
    });
    expect(listed).not.toHaveProperty("baseUrl");
    expect(
      (await server.app.inject(`/api/integrations/${integrationId}/sources`))
        .statusCode,
    ).toBe(401);
    const value = await bind(root());
    expect(value.count).toBe(2);
    const state = (await server.app.inject("/api/display/photos/state")).body;
    for (const secret of [
      directory,
      "family",
      "one.jpg",
      root().id,
      integrationId,
    ])
      expect(state).not.toContain(secret);
  });
  it("delivers resized, oriented, metadata-free images through scoped URLs and supports one-image sources", async () => {
    const rotated = await sharp({
      create: { width: 800, height: 400, channels: 3, background: "#507850" },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    await writeFile(path.join(photosDir, "family", "one.jpg"), rotated);
    const value = await bind(
      sources.find((source) => source.label === "one.jpg")!,
    );
    expect(value.count).toBe(1);
    const response = await server.app.inject(
      `${value.url}?index=0&width=200&height=200`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({
      "content-type": "image/jpeg",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    });
    const metadata = await sharp(response.rawPayload).metadata();
    expect(metadata.width).toBe(160);
    expect(metadata.height).toBe(320);
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect((await server.app.inject(`${value.url}?index=1`)).statusCode).toBe(
      404,
    );
    expect(
      (await server.app.inject(`${value.url}?width=99999`)).statusCode,
    ).toBe(400);
    expect(
      (await server.app.inject(`${value.url}?path=../outside.jpg`)).statusCode,
    ).toBe(400);
  });
  it("revokes URLs on unbinding, display deletion, disable, and integration configuration changes", async () => {
    const first = await bind(root());
    expect((await server.app.inject(first.url!)).statusCode).toBe(200);
    await server.app.inject({
      method: "PATCH",
      url: `/api/devices/${deviceId}`,
      headers,
      payload: { revision: 2, bindings: {} },
    });
    expect((await server.app.inject(first.url!)).statusCode).toBe(404);
    const second = await bind(root(), 3);
    await server.app.inject({
      method: "PATCH",
      url: `/api/integrations/${integrationId}`,
      headers,
      payload: { revision: 1, enabled: false },
    });
    expect((await server.app.inject(second.url!)).statusCode).toBe(404);
    await server.app.inject({
      method: "PATCH",
      url: `/api/integrations/${integrationId}`,
      headers,
      payload: { revision: 2, enabled: true },
    });
    await expect
      .poll(() => server.integrations.list()[0].status)
      .toBe("connected");
    expect((await server.app.inject(second.url!)).statusCode).toBe(404);
    const third = (await server.app.inject("/api/display/photos/state")).json()
      .data.photos.value;
    expect((await server.app.inject(third.url)).statusCode).toBe(200);
    await server.app.inject({
      method: "DELETE",
      url: `/api/devices/${deviceId}`,
      headers,
    });
    expect((await server.app.inject(third.url)).statusCode).toBe(404);
  });
  it("allows authorized draft previews without publishing or saving their selection", async () => {
    const response = await server.app.inject({
      method: "POST",
      url: `/api/devices/${deviceId}/preview`,
      headers,
      payload: {
        faceId: "builtin-photos",
        bindings: { photos: { integrationId, sourceId: root().id } },
      },
    });
    expect(response.statusCode).toBe(200);
    const value = response.json().data.photos.value;
    expect((await server.app.inject(value.url)).statusCode).toBe(200);
    expect(server.store.bindings(deviceId)).toEqual({});
    expect(
      (await server.app.inject("/api/display/photos/state")).json().data.photos
        .status,
    ).toBe("unbound");
    const unauthorized = await server.app.inject({
      method: "POST",
      url: `/api/devices/${deviceId}/preview`,
      payload: { faceId: "builtin-photos", bindings: {} },
    });
    expect(unauthorized.statusCode).toBe(401);
  });
  it("expires image capabilities and renews them in subsequent snapshots", async () => {
    const value = await bind(root());
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60000);
    expect((await server.app.inject(value.url!)).statusCode).toBe(404);
    const renewed = (
      await server.app.inject("/api/display/photos/state")
    ).json().data.photos.value;
    expect(renewed.url).not.toBe(value.url);
    expect((await server.app.inject(renewed.url)).statusCode).toBe(200);
    clock.mockRestore();
  });
  it("restores saved photo bindings after restart without retaining old capabilities", async () => {
    const value = await bind(root());
    await server.app.close();
    server = await createApp({
      dataDir: path.join(directory, "data"),
      photosDir,
    });
    await expect
      .poll(() => server.integrations.list()[0].status)
      .toBe("connected");
    expect((await server.app.inject(value.url!)).statusCode).toBe(404);
    const state = (await server.app.inject("/api/display/photos/state")).json();
    expect(state.face.id).toBe("builtin-photos");
    expect(state.data.photos.value.count).toBe(2);
    expect(
      (await server.app.inject(state.data.photos.value.url)).statusCode,
    ).toBe(200);
  });
  it("limits source file size before loading or decoding it", async () => {
    const value = await bind(
      sources.find((source) => source.label === "one.jpg")!,
    );
    await truncate(path.join(photosDir, "family", "one.jpg"), 51 * 1024 * 1024);
    expect((await server.app.inject(value.url!)).statusCode).toBe(404);
    const refreshed = await server.integrations.discover(integrationId, true);
    expect(refreshed.some((source) => source.label === "one.jpg")).toBe(false);
  });
  it("revalidates files even on cache hits, blocks symlink replacements and rejects corrupt images", async () => {
    const selected = sources.find((source) => source.label === "one.jpg")!;
    const value = await bind(selected);
    expect((await server.app.inject(value.url!)).statusCode).toBe(200);
    await rm(path.join(photosDir, "family", "one.jpg"));
    await symlink(
      path.join(directory, "outside.jpg"),
      path.join(photosDir, "family", "one.jpg"),
    );
    expect((await server.app.inject(value.url!)).statusCode).toBe(404);
    await rm(path.join(photosDir, "family", "one.jpg"));
    await writeFile(path.join(photosDir, "family", "one.jpg"), "not an image");
    expect((await server.app.inject(value.url!)).statusCode).toBe(404);
    await rm(path.join(photosDir, "family", "one.jpg"));
    expect((await server.app.inject(value.url!)).statusCode).toBe(404);
  });
  it("refreshes collections and handles empty folders, missing mounts and recovery", async () => {
    await bind(root());
    await writeFile(path.join(photosDir, "family", "three.png"), await image());
    await server.integrations.discover(integrationId, true);
    expect(
      (await server.app.inject("/api/display/photos/state")).json().data.photos
        .value.count,
    ).toBe(3);
    await rm(path.join(photosDir, "family", "one.jpg"));
    await rm(path.join(photosDir, "family", "three.png"));
    await rm(path.join(photosDir, "family", "nested", "two.jpg"));
    await server.integrations.discover(integrationId, true);
    expect(
      (await server.app.inject("/api/display/photos/state")).json().data.photos,
    ).toMatchObject({
      status: "unavailable",
      value: null,
    });
    const client = new MountedFolder(photosDir, "family");
    await client.confirm();
    await rename(photosDir, `${photosDir}-offline`);
    await expect(client.confirm()).rejects.toThrow(/mount/);
    await rename(`${photosDir}-offline`, photosDir);
    await client.confirm();
    client.close();
  });
  it("rejects unsafe configuration and incompatible provider settings", async () => {
    for (const folder of [
      "../",
      "/etc",
      "a/../b",
      "a//b",
      "a\\b",
      ".private",
      "a/\0b",
    ])
      expect(folderSchema.safeParse(folder).success, folder).toBe(false);
    expect(folderSchema.safeParse("").success).toBe(true);
    expect(folderSchema.safeParse("family/nested").success).toBe(true);
    const test = await server.app.inject({
      method: "POST",
      url: "/api/integrations/test",
      headers,
      payload: { type: "mounted-folder", folder: "family" },
    });
    expect(test.statusCode).toBe(200);
    expect(
      (
        await server.app.inject({
          method: "PATCH",
          url: `/api/integrations/${integrationId}`,
          headers,
          payload: { revision: 1, baseUrl: "http://localhost" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: "/api/integrations/test",
          headers,
          payload: { type: "mounted-folder", folder: "family/linked" },
        })
      ).statusCode,
    ).toBe(502);
  });
});

it("requires manifest/protocol v3 for images and validates image descriptors strictly", () => {
  const manifest = {
    ...testManifest,
    schemaVersion: 3,
    inputs: [{ key: "photos", label: "Photos", type: "image" }],
  };
  expect(manifestSchema.safeParse(manifest).success).toBe(true);
  expect(
    manifestSchema.safeParse({ ...manifest, schemaVersion: 2 }).success,
  ).toBe(false);
  const datum = {
    type: "image",
    status: "ready",
    value: {
      count: 2,
      revision: "a".repeat(64),
      url: `/api/photos/${"a".repeat(32)}`,
    },
    unit: null,
    updatedAt: 0,
    observedAt: 0,
    expiresAt: 90000,
  };
  expect(datumSchema.safeParse(datum).success).toBe(true);
  for (const value of [
    { ...datum.value, count: 0 },
    { ...datum.value, count: 10001 },
    { ...datum.value, url: "https://example.com/private.jpg" },
    { ...datum.value, path: "/private/file.jpg" },
  ])
    expect(datumSchema.safeParse({ ...datum, value }).success).toBe(false);
});
