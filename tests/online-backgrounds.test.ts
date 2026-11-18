import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  OnlineBackgrounds,
  creditText,
} from "../src/server/integrations/online-backgrounds.js";
import {
  OnlineHttp,
  onlineUrl,
  publicAddress,
} from "../src/server/integrations/online-http.js";
import { createApp } from "../src/server/app.js";
import { randomUUID } from "node:crypto";
import type { PhotoValue } from "../src/shared/face-data.js";
import type { Reading, Watch } from "../src/server/integrations/connector.js";
import {
  administrator,
  temporaryDirectory,
  testManifest,
  upload,
  faceZip,
} from "./helpers.js";
import {
  FakeOnlineBackgrounds,
  commonsPhoto,
  nasaPhoto,
} from "./fake-online-backgrounds.js";

describe("curated online background collections", () => {
  let client: OnlineBackgrounds;
  let fake: FakeOnlineBackgrounds;
  const watches: Watch[] = [];
  beforeEach(async () => {
    fake = await FakeOnlineBackgrounds.create();
    vi.spyOn(OnlineHttp.prototype, "get").mockImplementation(fake.get);
    client = new OnlineBackgrounds();
  });
  afterEach(() => {
    for (const watch of watches.splice(0)) watch.close();
    client.close();
    vi.restoreAllMocks();
  });
  async function select(ids = ["wikimedia-landscapes"]) {
    let values = new Map<string, Reading>();
    const callback = vi.fn((next: Map<string, Reading>) => {
      values = next;
    });
    const watch = client.watch(ids, callback);
    watches.push(watch);
    await watch.ready;
    return { values: () => values, callback, watch };
  }
  it("discovers seven fixed virtual albums without any network reads", async () => {
    expect(
      (await client.discover()).map((item) => [item.label, item.kind]),
    ).toEqual([
      ["Wikimedia · Landscapes", "album"],
      ["Wikimedia · Birds", "album"],
      ["Wikimedia · Flowers", "album"],
      ["Wikimedia · Architecture", "album"],
      ["NASA · Nebulae", "album"],
      ["NASA · Earth from space", "album"],
      ["NASA · Planets", "album"],
    ]);
    await client.confirm();
    expect(fake.requests).toHaveLength(0);
    await expect(select(["https://example.org/custom"])).rejects.toThrow(
      /Invalid/,
    );
    expect(fake.requests).toHaveLength(0);
  });
  it("loads only selected Wikimedia categories, paginates, deduplicates watches and preserves safe attribution", async () => {
    const first = commonsPhoto(1);
    first.imageinfo[0].extmetadata.Artist.value =
      "<b>A. &amp; B.</b><script>not a credit</script>";
    first.imageinfo[0].extmetadata.Attribution.value = "A. &#38; B.";
    fake.commonsPages = [
      { query: { pages: [first] }, continue: { gcmcontinue: "1" } },
      { query: { pages: [first, commonsPhoto(2)] } },
    ];
    const [one, two] = await Promise.all([select(), select()]);
    const value = one.values().get("wikimedia-landscapes")!.reading
      .value as PhotoValue;
    expect(value.count).toBe(2);
    expect(value.credits![0]).toMatchObject({
      title: "Landscape 1",
      attribution: "A. & B.",
      source: "Wikimedia Commons",
      license: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    });
    expect(two.values().get("wikimedia-landscapes")!.reading.value).toEqual(
      value,
    );
    expect(fake.requests).toHaveLength(2);
    expect(
      fake.requests.every(
        ({ url }) =>
          url.searchParams.get("gcmtitle") ===
          "Category:Featured pictures of landscapes",
      ),
    ).toBe(true);
    expect(JSON.stringify(value)).not.toMatch(
      /<script|thumburl|upload.wikimedia.org/,
    );
    const handle = await client.read("wikimedia-landscapes", 0, value.revision);
    expect(await handle.load()).toEqual(fake.image);
  });
  it("skips unsupported licenses, missing/oversized credits, restricted content, unsafe URLs and malformed items", async () => {
    const unlicensed = commonsPhoto(2);
    unlicensed.imageinfo[0].extmetadata.LicenseShortName.value =
      "All rights reserved";
    const uncredited = commonsPhoto(3);
    uncredited.imageinfo[0].extmetadata.Artist.value = "";
    uncredited.imageinfo[0].extmetadata.Attribution.value = "";
    const restricted = commonsPhoto(4);
    restricted.imageinfo[0].extmetadata.Restrictions.value =
      "personality rights";
    const external = commonsPhoto(5);
    external.imageinfo[0].thumburl = "https://example.org/image.jpg";
    const wrongLicense = commonsPhoto(6);
    wrongLicense.imageinfo[0].extmetadata.LicenseUrl.value =
      "https://example.org/license";
    const hugeCredit = commonsPhoto(7);
    hugeCredit.imageinfo[0].extmetadata.Artist.value = "x".repeat(1001);
    const svg = commonsPhoto(8);
    svg.imageinfo[0].mime = "image/svg+xml";
    const huge = commonsPhoto(9);
    huge.imageinfo[0].thumbheight = 40000;
    fake.commons = [
      commonsPhoto(1),
      unlicensed,
      uncredited,
      restricted,
      external,
      wrongLicense,
      hugeCredit,
      svg,
      huge,
      {} as ReturnType<typeof commonsPhoto>,
    ];
    const selected = await select();
    expect(
      selected.values().get("wikimedia-landscapes")!.reading.value,
    ).toMatchObject({ count: 1 });
  });
  it("accepts public domain/CC0, decodes metadata as text, and bounds albums to 48 images", async () => {
    expect(creditText("A &quot;photo&quot; &#x1f30d; &#999999999;")).toBe(
      'A "photo" 🌍',
    );
    fake.commonsPages = Array.from({ length: 4 }, (_, page) => ({
      query: {
        pages: Array.from({ length: 20 }, (_, index) => {
          const item = commonsPhoto(page * 20 + index + 1);
          item.imageinfo[0].extmetadata.LicenseShortName.value =
            page === 0 ? "Public domain" : "CC0";
          item.imageinfo[0].extmetadata.LicenseUrl.value =
            page === 0
              ? ""
              : "https://creativecommons.org/publicdomain/zero/1.0/";
          return item;
        }),
      },
      continue: { gcmcontinue: String(page + 1) },
    }));
    expect(
      (await select()).values().get("wikimedia-landscapes")!.reading.value,
    ).toMatchObject({ count: 48 });
    expect(fake.requests).toHaveLength(3);
  });
  it("filters NASA media and third-party credits, resolves sized manifests lazily and upgrades NASA HTTP asset URLs", async () => {
    const video = nasaPhoto("VIDEO");
    video.data[0].media_type = "video";
    const other = nasaPhoto("THIRD-PARTY");
    other.data[0].secondary_creator = "NASA/An independent photographer";
    const protectedImage = nasaPhoto("PROTECTED");
    protectedImage.data[0].description = "Image &copy; someone else";
    const mission = nasaPhoto("iss012e12345");
    mission.data[0].secondary_creator = "";
    mission.data[0].center = "JSC";
    const unknown = nasaPhoto("UNKNOWN");
    unknown.data[0].secondary_creator = "";
    fake.nasa = [nasaPhoto(), video, other, protectedImage, mission, unknown];
    const selected = await select(["nasa-earth"]);
    const value = selected.values().get("nasa-earth")!.reading
      .value as PhotoValue;
    expect(value.count).toBe(2);
    expect(value.credits!.map((credit) => credit.attribution).sort()).toEqual([
      "NASA/JPL-Caltech",
      "NASA/JSC",
    ]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].url.searchParams.get("q")).toBe("earth from space");
    const index = value.credits!.findIndex((credit) =>
      credit.title.includes("PIA12345"),
    );
    const handle = await client.read("nasa-earth", index, value.revision);
    await handle.load();
    expect(fake.requests).toHaveLength(3);
    expect(fake.requests.at(-1)!.url.href).toMatch(
      /^https:\/\/images-assets.nasa.gov\/image\/.+~large.jpg$/,
    );
    fake.files = ["https://evil.example/image/PIA12345/PIA12345~large.jpg"];
    await expect(handle.load()).rejects.toThrow(/supported size/);
    fake.files = ["https://images-assets.nasa.gov/image/OTHER/OTHER~large.jpg"];
    await expect(handle.load()).rejects.toThrow(/supported size/);
    fake.files = [
      "http://images-assets.nasa.gov/image/PIA12345/PIA12345~medium.jpg",
    ];
    await expect(handle.load()).resolves.toEqual(fake.image);
  });
  it("refreshes at six hours, isolates provider outages, backs off, expires old metadata and recovers", async () => {
    const selected = await select(["wikimedia-landscapes", "nasa-planets"]);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 6 * 3600000 + 1);
    fake.failCommons = true;
    fake.retryAfter = 5 * 60000;
    await client.confirm();
    expect(selected.values().get("wikimedia-landscapes")!.reading.status).toBe(
      "stale",
    );
    expect(selected.values().get("nasa-planets")!.reading.status).toBe("ready");
    const attempts = fake.requests.length;
    await client.confirm();
    expect(fake.requests).toHaveLength(attempts);
    clock.mockReturnValue(now + 6 * 3600000 + 4 * 60000);
    await client.confirm();
    expect(fake.requests).toHaveLength(attempts);
    clock.mockReturnValue(now + 25 * 3600000);
    await client.confirm();
    expect(selected.values().get("wikimedia-landscapes")!.reading.status).toBe(
      "unavailable",
    );
    await expect(client.read("wikimedia-landscapes", 0)).rejects.toThrow();
    fake.failCommons = false;
    clock.mockReturnValue(now + 26 * 3600000);
    await client.confirm();
    expect(selected.values().get("wikimedia-landscapes")!.reading.status).toBe(
      "ready",
    );
    clock.mockRestore();
  });
  it("does not reinterpret malformed or repeated pages as an empty album, but accepts confirmed-empty results", async () => {
    fake.commonsPages = [
      { query: { pages: [commonsPhoto()] }, continue: { gcmcontinue: "1" } },
      { query: { pages: [commonsPhoto()] }, continue: { gcmcontinue: "1" } },
    ];
    const selected = await select();
    expect(selected.values().get("wikimedia-landscapes")!.reading.status).toBe(
      "unavailable",
    );
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60001);
    fake.commonsPages = undefined;
    fake.commonsOverride = "not JSON";
    await client.confirm();
    expect(selected.values().get("wikimedia-landscapes")!.reading.status).toBe(
      "unavailable",
    );
    clock.mockReturnValue(Date.now() + 120001);
    fake.commonsOverride = { query: { pages: [] } };
    await client.confirm();
    expect(
      selected.values().get("wikimedia-landscapes")!.reading.value,
    ).toBeNull();
  });
  it("binds image reads to the metadata revision and discards cancelled/unselected work", async () => {
    const selected = await select();
    const revision = (
      selected.values().get("wikimedia-landscapes")!.reading.value as PhotoValue
    ).revision;
    await expect(
      client.read("wikimedia-landscapes", 0, "b".repeat(64)),
    ).rejects.toThrow();
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 6 * 3600000 + 1);
    fake.commons = [commonsPhoto(3)];
    await client.confirm();
    await expect(
      client.read("wikimedia-landscapes", 0, revision),
    ).rejects.toThrow();
    selected.watch.close();
    const attempts = fake.requests.length;
    clock.mockReturnValue(Date.now() + 11 * 60000);
    await client.confirm();
    expect(fake.requests).toHaveLength(attempts);
    await expect(client.read("wikimedia-landscapes", 0)).rejects.toThrow();
    clock.mockRestore();
    fake.block = (signal) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    const callback = vi.fn();
    const watch = client.watch(["wikimedia-birds"], callback);
    watches.push(watch);
    const rejected = expect(watch.ready).rejects.toThrow(/cancelled/);
    watch.close();
    await rejected;
    expect(callback).not.toHaveBeenCalled();
  });
  it("does not disconnect other albums when a removed source cancels its refresh", async () => {
    const selected = await select(["wikimedia-landscapes", "nasa-nebulae"]);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 3600000 + 1);
    fake.block = (signal, url) =>
      url.hostname === "commons.wikimedia.org"
        ? new Promise((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          )
        : Promise.resolve();
    const confirming = client.confirm();
    const remaining = client.watch(["nasa-nebulae"], () => {});
    watches.push(remaining);
    selected.watch.close();
    await expect(confirming).resolves.toBeUndefined();
    await remaining.ready;
    await expect(client.read("nasa-nebulae", 0)).resolves.toBeDefined();
  });
});

describe("online background management and scoped delivery", () => {
  let fake: FakeOnlineBackgrounds;
  let server: Awaited<ReturnType<typeof createApp>>;
  let directory: string;
  let headers: Record<string, string>;
  let integrationId: string;
  let deviceId: string;
  beforeEach(async () => {
    fake = await FakeOnlineBackgrounds.create();
    vi.spyOn(OnlineHttp.prototype, "get").mockImplementation(fake.get);
    directory = await temporaryDirectory("screensvr-online-");
    server = await createApp({ dataDir: directory });
    headers = await administrator(server.app);
    integrationId = server.integrations
      .list()
      .find((integration) => integration.type === "online-backgrounds")!.id;
    deviceId = (
      await server.app.inject({
        method: "POST",
        url: "/api/devices",
        headers,
        payload: { name: "Online", timezone: "UTC", faceId: "builtin-photos" },
      })
    ).json().id;
  });
  afterEach(async () => {
    await server?.app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  async function bind(sourceId = "wikimedia-landscapes", revision = 1) {
    const response = await server.app.inject({
      method: "PATCH",
      url: `/api/devices/${deviceId}`,
      headers,
      payload: { revision, bindings: { photos: { integrationId, sourceId } } },
    });
    expect(response.statusCode, response.body).toBe(200);
    await expect
      .poll(() => server.states.state(deviceId)?.data.photos.status)
      .toBe("ready");
    return server.states.state(deviceId)!.data.photos.value as PhotoValue;
  }
  it("is automatically enabled without credentials, duplicate setup or internet reads on startup or discovery", async () => {
    expect(server.integrations.list()[0]).toMatchObject({
      type: "online-backgrounds",
      status: "connected",
      hasCredentials: false,
      enabled: true,
    });
    expect(server.integrations.list()[0]).not.toHaveProperty("baseUrl");
    expect(server.store.integration(integrationId)!.credentials).toBe("");
    const sources = await server.app.inject({
      url: `/api/integrations/${integrationId}/sources?type=image&q=NASA`,
      headers,
    });
    expect(sources.json().total).toBe(3);
    expect(fake.requests).toHaveLength(0);
    expect(server.store.integrations()).toHaveLength(1);
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: "/api/integrations",
          headers,
          payload: { type: "online-backgrounds", name: "Duplicate" },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await server.app.inject(`/api/integrations/${integrationId}/sources`))
        .statusCode,
    ).toBe(401);
    for (const [key, value] of [
      ["baseUrl", "https://example.org"],
      ["token", "unused"],
      ["folder", "photos"],
      ["timezone", "UTC"],
      ["feedUrl", "https://example.org/a.ics"],
    ]) {
      expect(
        (
          await server.app.inject({
            method: "PATCH",
            url: `/api/integrations/${integrationId}`,
            headers,
            payload: { revision: 1, [key]: value },
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: "/api/integrations",
          headers,
          payload: {
            type: "online-backgrounds",
            name: "Bad",
            baseUrl: "https://example.org",
          },
        })
      ).statusCode,
    ).toBe(400);
    for (const [url, payload] of [
      ["/api/integrations/test", { type: "online-backgrounds" }],
      [`/api/integrations/${integrationId}/test`, {}],
    ] as const)
      expect(
        (await server.app.inject({ method: "POST", url, payload, headers }))
          .statusCode,
      ).toBe(200);
    expect(fake.requests).toHaveLength(4);
    fake.failNasa = true;
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: `/api/integrations/${integrationId}/test`,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(502);
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: `/api/integrations/${integrationId}/test`,
          headers,
          payload: { baseUrl: "https://example.org" },
        })
      ).statusCode,
    ).toBe(400);
  });
  it("previews without saving and delivers only resized images plus normalized public credits", async () => {
    const response = await server.app.inject({
      method: "POST",
      url: `/api/devices/${deviceId}/preview`,
      headers,
      payload: {
        faceId: "builtin-photos",
        bindings: { photos: { integrationId, sourceId: "nasa-nebulae" } },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(server.store.bindings(deviceId)).toEqual({});
    const preview = response.json().data.photos.value as PhotoValue;
    expect(preview.credits![0].source).toBe("NASA");
    const image = await server.app.inject(
      `${preview.url}?index=0&width=200&height=200&v=${preview.revision}`,
    );
    expect(image.statusCode, image.body).toBe(200);
    const metadata = await sharp(image.rawPayload).metadata();
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.height).toBeLessThanOrEqual(320);
    expect(image.headers["access-control-allow-origin"]).toBe("*");
    const value = await bind();
    const state = await server.app.inject("/api/display/online/state");
    expect(state.body).not.toMatch(
      /upload.wikimedia.org|images-assets.nasa.gov|<a href|extmetadata/,
    );
    expect(value.credits![0]).toMatchObject({
      source: "Wikimedia Commons",
      attribution: "A. Photographer",
    });
    expect(
      (await server.app.inject(`${value.url}?v=${"b".repeat(64)}`)).statusCode,
    ).toBe(404);
    expect((await server.app.inject(`${value.url}?index=999`)).statusCode).toBe(
      404,
    );
  });
  it("requires attribution-capable faces and rejects arbitrary source IDs", async () => {
    const installed = await upload(
      server.app,
      headers,
      faceZip({
        ...testManifest,
        schemaVersion: 3,
        inputs: [{ key: "photos", label: "Photos", type: "image" }],
      }),
    );
    expect(installed.statusCode).toBe(201);
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: `/api/devices/${deviceId}/preview`,
          headers,
          payload: {
            faceId: "test-face",
            bindings: {
              photos: { integrationId, sourceId: "wikimedia-landscapes" },
            },
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await server.app.inject({
          method: "PATCH",
          url: `/api/devices/${deviceId}`,
          headers,
          payload: {
            revision: 1,
            bindings: { photos: { integrationId, sourceId: "custom-search" } },
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(fake.requests).toHaveLength(0);
  });
  it("revokes capabilities on edits/disable and restores saved albums after restart without an integration key", async () => {
    const first = await bind();
    expect((await server.app.inject(first.url!)).statusCode).toBe(200);
    await server.app.close();
    await writeFile(path.join(directory, "integration-key"), "invalid key");
    server = await createApp({ dataDir: directory });
    await expect
      .poll(() => server.states.state(deviceId)?.data.photos.status)
      .toBe("ready");
    expect((await server.app.inject(first.url!)).statusCode).toBe(404);
    const current = server.states.state(deviceId)!.data.photos
      .value as PhotoValue;
    expect((await server.app.inject(current.url!)).statusCode).toBe(200);
    expect(
      (
        await server.app.inject({
          method: "PATCH",
          url: `/api/integrations/${integrationId}`,
          headers,
          payload: { revision: 1, enabled: false },
        })
      ).statusCode,
    ).toBe(200);
    expect((await server.app.inject(current.url!)).statusCode).toBe(404);
    expect(server.states.state(deviceId)!.data.photos.status).toBe(
      "unavailable",
    );
    const persisted = await readFile(path.join(directory, "screensvr.sqlite"));
    expect(persisted.includes(Buffer.from("A. Photographer"))).toBe(false);
  });
  it("preserves a disabled or renamed connection across restarts and does not duplicate existing upgrade connections", async () => {
    await server.app.inject({
      method: "PATCH",
      url: `/api/integrations/${integrationId}`,
      headers,
      payload: { revision: 1, name: "Space photos", enabled: false },
    });
    // Simulate a previously configured connection on an installation upgrading
    // from before automatic provisioning was introduced.
    server.store.db
      .prepare("DELETE FROM meta WHERE key = 'online-backgrounds-provisioned'")
      .run();
    await server.app.close();
    server = await createApp({ dataDir: directory });
    expect(server.integrations.list()).toEqual([
      expect.objectContaining({
        id: integrationId,
        name: "Space photos",
        enabled: false,
        status: "disabled",
        revision: 2,
      }),
    ]);
    expect(fake.requests).toHaveLength(0);
    await server.app.close();
    server = await createApp({ dataDir: directory });
    expect(server.integrations.list()).toHaveLength(1);
    expect(server.integrations.list()[0].enabled).toBe(false);
  });
  it("respects removal across restarts and allows an administrator to restore the connection", async () => {
    expect(
      (
        await server.app.inject({
          method: "DELETE",
          url: `/api/integrations/${integrationId}`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    await server.app.close();
    server = await createApp({ dataDir: directory });
    expect(server.integrations.list()).toEqual([]);
    const restored = await server.app.inject({
      method: "POST",
      url: "/api/integrations",
      headers,
      payload: { type: "online-backgrounds", name: "Online backgrounds" },
    });
    expect(restored.statusCode).toBe(201);
    expect(restored.json()).toMatchObject({
      type: "online-backgrounds",
      enabled: true,
      hasCredentials: false,
    });
    expect(fake.requests).toHaveLength(0);
  });
  it("provisions existing installations at their custom-integration limit without using a custom slot", async () => {
    server.store.db
      .prepare("DELETE FROM integrations WHERE id = ?")
      .run(integrationId);
    server.store.db
      .prepare("DELETE FROM meta WHERE key = 'online-backgrounds-provisioned'")
      .run();
    const add = server.store.db.prepare(
      "INSERT INTO integrations (id, type, name, base_url, credentials, enabled) VALUES (?, 'home-assistant', ?, 'https://home.example', '', 0)",
    );
    const ids = Array.from({ length: 10 }, () => randomUUID());
    ids.forEach((id, index) => add.run(id, `Home ${index}`));
    await server.app.close();
    server = await createApp({ dataDir: directory });
    expect(server.integrations.list()).toHaveLength(11);
    const online = server.integrations
      .list()
      .find((item) => item.type === "online-backgrounds")!;
    expect(online).toMatchObject({ enabled: true, status: "connected" });
    const payload = {
      type: "home-assistant",
      name: "Extra",
      baseUrl: "https://home.example",
      token: "secret",
      enabled: false,
    };
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: "/api/integrations",
          headers,
          payload,
        })
      ).statusCode,
    ).toBe(400);
    await server.app.inject({
      method: "DELETE",
      url: `/api/integrations/${ids[0]}`,
      headers,
    });
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: "/api/integrations",
          headers,
          payload,
        })
      ).statusCode,
    ).toBe(201);
    expect(server.integrations.list()).toHaveLength(11);
    expect(fake.requests).toHaveLength(0);
  });
});

it("restricts online requests to fixed HTTPS hosts and public socket addresses", () => {
  expect(onlineUrl("https://images-api.nasa.gov/search?q=nebula")).toContain(
    "/search",
  );
  for (const url of [
    "http://images-api.nasa.gov/search",
    "https://example.org/image.jpg",
    "https://images-api.nasa.gov:444/search",
    "https://user:secret@images-api.nasa.gov/search",
    "https://images-api.nasa.gov/search#secret",
    "https://127.0.0.1/photo",
  ])
    expect(() => onlineUrl(url)).toThrow();
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.100.200",
    "::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "::ffff:192.168.0.1",
    "fe80::1",
    "2001:db8::1",
    "64:ff9b::7f00:1",
    "::127.0.0.1",
  ])
    expect(publicAddress(address), address).toBe(false);
  expect(publicAddress("8.8.8.8")).toBe(true);
  expect(publicAddress("2606:4700:4700::1111")).toBe(true);
});
