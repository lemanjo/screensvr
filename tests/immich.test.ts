import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { Immich } from "../src/server/integrations/immich.js";
import type { Reading, Watch } from "../src/server/integrations/connector.js";
import { immichUrl } from "../src/server/integrations/network.js";
import { createApp } from "../src/server/app.js";
import type { PhotoValue } from "../src/shared/face-data.js";
import { administrator, temporaryDirectory } from "./helpers.js";
import { FakeImmich, immichToken } from "./fake-immich.js";

describe("Immich 3.x connector", () => {
  let fake: FakeImmich;
  let client: Immich | undefined;
  const watches: Watch[] = [];
  const disconnected = vi.fn();
  beforeEach(async () => {
    fake = await FakeImmich.start();
    disconnected.mockClear();
  });
  afterEach(async () => {
    for (const watch of watches.splice(0)) watch.close();
    client?.close();
    client = undefined;
    await fake.close();
    vi.restoreAllMocks();
  });
  async function connect(url = fake.url) {
    client = await Immich.connect(url, immichToken, disconnected);
    return client;
  }
  async function select(ids = [fake.family]) {
    let values = new Map<string, Reading>();
    const callback = vi.fn((readings: Map<string, Reading>) => {
      values = readings;
    });
    const watch = client!.watch(ids, callback);
    watches.push(watch);
    await watch.ready;
    return { values: () => values, watch, callback };
  }
  it("normalizes API roots and validates URLs without permitting credential or metadata targets", () => {
    expect(immichUrl("https://photos.example/api/")).toBe(
      "https://photos.example",
    );
    expect(immichUrl("http://localhost:2283/")).toBe("http://localhost:2283");
    for (const url of [
      "file:///etc/passwd",
      "http://user:key@localhost",
      "http://localhost/?key=x",
      "http://169.254.169.254",
      "http://[::ffff:169.254.169.254]",
    ])
      expect(() => immichUrl(url)).toThrow(/Immich/);
  });
  it("discovers owned/shared/empty albums without loading their assets and accepts a /api root", async () => {
    await connect(`${fake.url}/api/`);
    expect(
      (await client!.discover()).map((source) => [
        source.label,
        source.kind,
        source.available,
      ]),
    ).toEqual([
      ["Empty", "album", false],
      ["Family", "album", true],
      ["Shared holidays", "album", true],
    ]);
    expect(
      fake.requests.some((request) => request.path === "/api/search/metadata"),
    ).toBe(false);
  });
  it("checks the version and least-privilege key, without exposing upstream diagnostics", async () => {
    fake.version.major = 2;
    await expect(connect()).rejects.toThrow(/3\.4\.1/);
    fake.version = { major: 3, minor: 4, patch: 0 };
    await expect(connect()).rejects.toThrow(/3\.4\.1/);
    fake.version.patch = 1;
    fake.permissions = ["album.read", "asset.read"];
    await expect(connect()).rejects.toThrow(
      /album.read, asset.read, and asset.view/,
    );
    fake.rejectKey = true;
    await expect(connect()).rejects.toThrow("Immich rejected the API key.");
    fake.rejectKey = false;
    fake.permissions = ["all"];
    await expect(connect()).resolves.toBeDefined();
  });
  it("paginates, defensively filters non-photos/private/trashed assets, and deduplicates simultaneous watches", async () => {
    fake.pageSize = 2;
    fake.ignoreFilters = true;
    const album = fake.albums.get(fake.family)!;
    for (const values of [
      { type: "VIDEO" },
      { visibility: "hidden" },
      { visibility: "locked" },
      { isTrashed: true },
      { isOffline: true },
    ])
      album.assets.push(fake.addAsset(values).id);
    await connect();
    const [one, two] = await Promise.all([select(), select()]);
    expect(one.values().get(fake.family)!.reading.value).toMatchObject({
      count: 2,
      url: null,
    });
    expect(two.values().get(fake.family)!.reading).toEqual(
      one.values().get(fake.family)!.reading,
    );
    const searches = fake.requests.filter(
      (request) => request.path === "/api/search/metadata",
    );
    expect(searches).toHaveLength(4);
    expect(
      searches.every(
        (request) => request.body!.filter.albumIds.any[0] === fake.family,
      ),
    ).toBe(true);
    expect(searches.every((request) => request.method === "POST")).toBe(true);
    expect(searches[0].body!.filter.visibility.in).toEqual([
      "timeline",
      "archive",
    ]);
    one.watch.close();
    await client!.confirm();
    expect(two.values().get(fake.family)!.reading.status).toBe("ready");
  });
  it("refreshes membership and revisions, isolates inaccessible/empty albums, and renews steady leases", async () => {
    await connect();
    const selected = await select([fake.family, fake.shared, fake.empty]);
    const first = selected.values().get(fake.family)!.reading;
    fake.albums.get(fake.family)!.assets.push(fake.addAsset().id);
    fake.albums.get(fake.shared)!.denied = true;
    await client!.confirm();
    expect(selected.values().get(fake.family)!.reading.value).toMatchObject({
      count: 3,
    });
    expect(selected.values().get(fake.family)!.reading.value).not.toEqual(
      first.value,
    );
    expect(selected.values().get(fake.shared)!.reading.status).toBe(
      "unavailable",
    );
    expect(selected.values().get(fake.empty)!.reading.value).toBeNull();
    const steady = selected.values().get(fake.family)!.reading;
    await client!.confirm();
    expect(selected.values().get(fake.family)!.reading.value).toEqual(
      steady.value,
    );
    expect(
      selected.values().get(fake.family)!.reading.expiresAt,
    ).toBeGreaterThanOrEqual(steady.expiresAt!);
    fake.albums.delete(fake.family);
    await client!.confirm();
    expect(selected.values().get(fake.family)!.reading.status).toBe(
      "unavailable",
    );
    expect(disconnected).not.toHaveBeenCalled();
  });
  it("checks membership on every image read and keys changed previews by upstream revision", async () => {
    await connect();
    await select();
    const photo = await client!.read(fake.family, 0);
    expect(await photo.load()).toEqual(fake.preview);
    const album = fake.albums.get(fake.family)!;
    const asset = fake.assets.get(album.assets.slice().sort()[0])!;
    asset.updatedAt = "2026-11-02T00:00:00.000Z";
    expect((await client!.read(fake.family, 0)).key).not.toBe(photo.key);
    album.assets = album.assets.filter((id) => id !== asset.id);
    await expect(client!.read(fake.family, 0)).rejects.toThrow(
      "Photo unavailable.",
    );
    await expect(client!.read(fake.privateAlbum, 0)).rejects.toThrow();
    await expect(client!.read(fake.family, 999)).rejects.toThrow();
  });
  it("rejects loops, oversized responses/collections, redirects, and malformed JSON", async () => {
    await connect();
    fake.repeatCursor = true;
    await expect(select()).rejects.toThrow(/repeated pagination/);
    fake.repeatCursor = false;
    await select();
    fake.redirectPreview = true;
    await expect((await client!.read(fake.family, 0)).load()).rejects.toThrow(
      /unsuccessful/,
    );
    expect(
      fake.requests.every((request) => !request.path.includes("original")),
    ).toBe(true);
    fake.jsonOverride = "not json";
    await expect(client!.discover()).rejects.toThrow(/invalid/);
    fake.jsonOverride = " ".repeat(16 * 1024 * 1024 + 1);
    await expect(client!.discover()).rejects.toThrow(/size limit/);
    fake.jsonOverride = undefined;
    fake.albums.get(fake.family)!.assets = Array.from(
      { length: 10001 },
      () => fake.addAsset().id,
    );
    await expect(client!.confirm()).rejects.toThrow(/10,000/);
  });
  it("reports credential revocation and cancels closed/replaced watches without late callbacks", async () => {
    await connect();
    fake.delay = 200;
    const callback = vi.fn();
    const watch = client!.watch([fake.family], callback);
    const rejected = expect(watch.ready).rejects.toThrow();
    watch.close();
    await rejected;
    expect(callback).not.toHaveBeenCalled();
    fake.delay = 0;
    await select();
    fake.permissions = ["album.read"];
    await expect(client!.confirm()).rejects.toThrow(/permissions/);
    expect(disconnected).toHaveBeenCalledWith(
      expect.objectContaining({ authentication: true }),
    );
    fake.permissions = ["album.read", "asset.read", "asset.view"];
    fake.rejectKey = true;
    await expect(client!.read(fake.family, 0)).rejects.toThrow(/rejected/);
    client!.close();
    await expect(client!.discover()).rejects.toThrow(/cancelled/);
  });
  it("aborts startup through the connection signal", async () => {
    fake.delay = 200;
    const abort = new AbortController();
    const pending = Immich.connect(
      fake.url,
      immichToken,
      disconnected,
      abort.signal,
    );
    abort.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe("Immich management and scoped photo delivery", () => {
  let fake: FakeImmich;
  let server: Awaited<ReturnType<typeof createApp>>;
  let directory: string;
  let headers: Record<string, string>;
  let integrationId: string;
  let deviceId: string;
  beforeEach(async () => {
    fake = await FakeImmich.start();
    directory = await temporaryDirectory("screensvr-immich-");
    server = await createApp({ dataDir: directory });
    headers = await administrator(server.app);
    const result = await server.app.inject({
      method: "POST",
      url: "/api/integrations",
      headers,
      payload: {
        type: "immich",
        name: "Immich photos",
        baseUrl: `${fake.url}/api`,
        token: immichToken,
      },
    });
    expect(result.statusCode).toBe(201);
    integrationId = result.json().id;
    await expect
      .poll(() => server.integrations.list()[0].status)
      .toBe("connected");
    deviceId = (
      await server.app.inject({
        method: "POST",
        url: "/api/devices",
        headers,
        payload: { name: "Immich", timezone: "UTC", faceId: "builtin-photos" },
      })
    ).json().id;
  });
  afterEach(async () => {
    await server?.app.close();
    await fake.close();
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  async function bind(sourceId = fake.family, revision = 1) {
    const response = await server.app.inject({
      method: "PATCH",
      url: `/api/devices/${deviceId}`,
      headers,
      payload: { revision, bindings: { photos: { integrationId, sourceId } } },
    });
    expect(response.statusCode).toBe(200);
    await expect
      .poll(async () => {
        const state = (
          await server.app.inject("/api/display/immich/state")
        ).json();
        return state.data.photos.status;
      })
      .toBe("ready");
    return (await server.app.inject("/api/display/immich/state")).json().data
      .photos.value as PhotoValue;
  }
  it("encrypts keys, validates provider fields, and tests new/saved connections without returning credentials", async () => {
    const list = await server.app.inject({ url: "/api/integrations", headers });
    expect(list.json()[0]).toMatchObject({
      type: "immich",
      baseUrl: fake.url,
      hasCredentials: true,
    });
    expect(list.body).not.toContain(immichToken);
    expect(server.store.integration(integrationId)!.credentials).not.toContain(
      immichToken,
    );
    expect(
      (await readFile(path.join(directory, "screensvr.sqlite"))).includes(
        Buffer.from(immichToken),
      ),
    ).toBe(false);
    for (const [url, payload] of [
      [
        "/api/integrations/test",
        { type: "immich", baseUrl: fake.url, token: immichToken },
      ],
      [`/api/integrations/${integrationId}/test`, {}],
    ] as const) {
      expect(
        (await server.app.inject({ method: "POST", url, headers, payload }))
          .statusCode,
      ).toBe(200);
    }
    for (const [method, url, payload] of [
      [
        "PATCH",
        `/api/integrations/${integrationId}`,
        { revision: 1, folder: "wrong" },
      ],
      ["POST", `/api/integrations/${integrationId}/test`, { folder: "wrong" }],
      [
        "POST",
        "/api/integrations",
        { type: "immich", name: "Bad", baseUrl: fake.url },
      ],
      [
        "POST",
        "/api/integrations/test",
        {
          type: "immich",
          baseUrl: "http://169.254.169.254",
          token: immichToken,
        },
      ],
    ] as const) {
      expect(
        (await server.app.inject({ method, url, headers, payload })).statusCode,
      ).toBe(400);
    }
    expect(
      (await server.app.inject(`/api/integrations/${integrationId}/sources`))
        .statusCode,
    ).toBe(401);
    const edited = await server.app.inject({
      method: "PATCH",
      url: `/api/integrations/${integrationId}`,
      headers,
      payload: { revision: 1, name: "Renamed", baseUrl: `${fake.url}/api/` },
    });
    expect(edited.json()).toMatchObject({
      revision: 2,
      hasCredentials: true,
      baseUrl: fake.url,
    });
    await expect
      .poll(() => server.integrations.list()[0].status)
      .toBe("connected");
  });
  it("previews without changing the live display, strips metadata, and hides all upstream identifiers", async () => {
    const response = await server.app.inject({
      method: "POST",
      url: `/api/devices/${deviceId}/preview`,
      headers,
      payload: {
        faceId: "builtin-photos",
        bindings: { photos: { integrationId, sourceId: fake.shared } },
      },
    });
    expect(response.statusCode).toBe(200);
    const preview: PhotoValue = response.json().data.photos.value;
    expect(preview.count).toBe(1);
    expect(
      (await server.app.inject("/api/display/immich/state")).json().data.photos
        .status,
    ).toBe("unbound");
    const image = await server.app.inject(
      `${preview.url}?index=0&width=200&height=200`,
    );
    expect(image.statusCode).toBe(200);
    expect(image.headers).toMatchObject({
      "content-type": "image/jpeg",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    const metadata = await sharp(image.rawPayload).metadata();
    expect(metadata.width).toBeLessThanOrEqual(320);
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    const live = await bind();
    const state = await server.app.inject("/api/display/immich/state");
    for (const secret of [
      immichToken,
      fake.url,
      fake.family,
      integrationId,
      "do-not-expose",
      "Family",
      ...fake.assets.keys(),
    ])
      expect(state.body).not.toContain(secret);
    expect((await server.app.inject(`${live.url}?index=0`)).statusCode).toBe(
      200,
    );
  });
  it("never serves cached bytes after removal/revocation and immediately invalidates changed bindings", async () => {
    const value = await bind();
    const url = `${value.url}?index=0`;
    expect((await server.app.inject(url)).statusCode).toBe(200);
    const album = fake.albums.get(fake.family)!;
    const saved = [...album.assets];
    album.assets = [];
    expect((await server.app.inject(url)).statusCode).toBe(404);
    album.assets = saved;
    expect((await server.app.inject(url)).statusCode).toBe(200);
    await bind(fake.shared, 2);
    expect((await server.app.inject(url)).statusCode).toBe(404);
    const current = (
      await server.app.inject("/api/display/immich/state")
    ).json().data.photos.value;
    fake.rejectKey = true;
    expect((await server.app.inject(current.url)).statusCode).toBe(404);
    expect(server.integrations.list()[0].status).toBe("authentication-error");
  });
  it("restores bindings after restart, replaces keys safely, and revokes disabled integration URLs", async () => {
    const value = await bind();
    await server.app.close();
    server = await createApp({ dataDir: directory });
    await expect
      .poll(
        async () =>
          (await server.app.inject("/api/display/immich/state")).json().data
            .photos.status,
      )
      .toBe("ready");
    expect((await server.app.inject(value.url!)).statusCode).toBe(404);
    const current = (
      await server.app.inject("/api/display/immich/state")
    ).json().data.photos.value;
    expect((await server.app.inject(current.url)).statusCode).toBe(200);
    const disabled = await server.app.inject({
      method: "PATCH",
      url: `/api/integrations/${integrationId}`,
      headers,
      payload: { revision: 1, token: immichToken, enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect((await server.app.inject(current.url)).statusCode).toBe(404);
    expect(
      (await server.app.inject("/api/display/immich/state")).json().data.photos
        .status,
    ).toBe("unavailable");
  });
  it("polls album changes without a settings revision and automatically recovers from transient failures", async () => {
    await bind();
    await server.app.close();
    const interval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(
      (callback, delay, ...args) =>
        interval(callback, delay === 30000 ? 25 : delay, ...args),
    );
    server = await createApp({ dataDir: directory });
    const state = async () =>
      (await server.app.inject("/api/display/immich/state")).json();
    await expect
      .poll(async () => (await state()).data.photos.status)
      .toBe("ready");
    const before = await state();
    fake.albums.get(fake.family)!.assets.push(fake.addAsset().id);
    await expect
      .poll(async () => (await state()).data.photos.value?.count)
      .toBe(3);
    expect((await state()).revision).toBe(before.revision);
    fake.status = 503;
    await expect
      .poll(async () => (await state()).data.photos.status)
      .toBe("stale");
    fake.status = 0;
    await expect
      .poll(async () => (await state()).data.photos.status, { timeout: 5000 })
      .toBe("ready");
    const current = await state();
    expect(current.data.photos.value.count).toBe(3);
    expect(current.revision).toBe(before.revision);
  });
  it("rotates a rejected API key and rejects redirects/unsupported preview bytes", async () => {
    const value = await bind();
    fake.token = "replacement-immich-key-for-tests-only";
    expect((await server.app.inject(value.url!)).statusCode).toBe(404);
    expect(server.integrations.list()[0].status).toBe("authentication-error");
    const replaced = await server.app.inject({
      method: "PATCH",
      url: `/api/integrations/${integrationId}`,
      headers,
      payload: { revision: 1, token: fake.token },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.body).not.toContain(fake.token);
    await expect
      .poll(
        async () =>
          (await server.app.inject("/api/display/immich/state")).json().data
            .photos.status,
      )
      .toBe("ready");
    expect((await server.app.inject(value.url!)).statusCode).toBe(404);
    const current = (
      await server.app.inject("/api/display/immich/state")
    ).json().data.photos.value;
    fake.redirectPreview = true;
    expect((await server.app.inject(current.url)).statusCode).toBe(404);
    fake.redirectPreview = false;
    fake.previewOverride = Buffer.from("<svg>not a safe image</svg>");
    expect((await server.app.inject(current.url)).statusCode).toBe(404);
  });
});
