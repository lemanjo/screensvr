import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/server/app.js";
import {
  administrator,
  temporaryDirectory,
  testManifest,
  faceZip,
  upload,
} from "./helpers.js";
import type { SceneConfiguration } from "../src/shared/scenes.js";
import type { ConnectorFactory } from "../src/server/integrations/connector.js";
import { normalize } from "../src/server/integrations/normalize.js";

let server: Awaited<ReturnType<typeof createApp>>;
let directory: string;
let headers: Record<string, string>;
let id: string;
let now: number;
const watched: string[][] = [];
const readings = ["sensor.day", "sensor.night"].map((id) =>
  normalize(id, {
    state: id === "sensor.day" ? "21" : "19",
    attributes: { device_class: "temperature", unit_of_measurement: "°C" },
    updated: 0,
  })!,
);
const factory: ConnectorFactory = async () => ({
  discover: async () => readings.map((value) => value.source),
  confirm: async () => {},
  close: () => {},
  watch: (ids, callback) => {
    watched.push(ids);
    callback(
      new Map(
        readings
          .filter((value) => ids.includes(value.source.id))
          .map((value) => [value.source.id, value]),
      ),
    );
    return { ready: Promise.resolve(), close: () => {} };
  },
});
beforeEach(async () => {
  now = Date.parse("2026-11-16T08:00:00Z");
  watched.length = 0;
  directory = await temporaryDirectory("screensvr-scenes-");
  server = await createApp({
    dataDir: directory,
    now: () => now,
    connectorFactory: factory,
  });
  headers = await administrator(server.app);
  const result = await server.app.inject({
    method: "POST",
    url: "/api/devices",
    headers,
    payload: { name: "Study", faceId: "builtin-digital", timezone: "UTC" },
  });
  id = result.json().id;
});
afterEach(async () => {
  await server?.app.close();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});
function config(): SceneConfiguration {
  const device = server.store.device(id)!;
  const selection = server.store.selection(id)!;
  return {
    revision: device.revision,
    scenes: server.store.scenes(id),
    schedule: server.store.schedule(id),
    activeSceneId: selection.sceneId,
    nextTransition: selection.next,
  };
}
async function request(
  path: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  payload: object = {},
  status = 200,
) {
  const result = await server.app.inject({
    method,
    url: `/api/devices/${id}${path}`,
    headers,
    payload: { revision: config().revision, ...payload },
  });
  expect(result.statusCode, result.body).toBe(status);
  return result.json() as SceneConfiguration & { createdSceneId: string };
}
async function create(name = "Night", faceId = "builtin-digital") {
  return (
    await request(
      "/scenes",
      "POST",
      {
        name,
        faceId,
        settings: faceId === "builtin-digital" ? { nightMode: true } : {},
      },
      201,
    )
  ).createdSceneId;
}
async function enable(day: string, night: string) {
  return request("/schedule", "PUT", {
    schedule: {
      enabled: true,
      entries: [
        { days: [1, 2, 3, 4, 5, 6, 7], time: "07:00", sceneId: day },
        { days: [1, 2, 3, 4, 5, 6, 7], time: "19:00", sceneId: night },
      ],
    },
  });
}

it("creates and duplicates inactive scenes without changing the current face", async () => {
  const original = config().activeSceneId;
  const night = await create();
  expect(server.states.state(id)).toMatchObject({
    sceneId: original,
    settings: { nightMode: false },
  });
  const copy = await request(
    "/scenes",
    "POST",
    { name: "Another night", copyFrom: night },
    201,
  );
  expect(
    config().scenes.find((scene) => scene.id === copy.createdSceneId)?.settings
      .nightMode,
  ).toBe(true);
  await request(`/scenes/${night}`, "PATCH", {
    name: "Quiet night",
    settings: { nightMode: true, format: "12" },
  });
  await request(`/scenes/${night}/activate`, "POST");
  expect(server.states.state(id)).toMatchObject({
    sceneId: night,
    settings: { nightMode: true, format: "12" },
  });
  await request(`/scenes/${original}/activate`, "POST");
  expect(server.states.state(id)?.settings.nightMode).toBe(false);
});

it("transitions automatically without changing edit revisions and publishes ordered snapshots", async () => {
  const day = config().activeSceneId,
    night = await create();
  await enable(day, night);
  const first = server.states.state(id)!;
  const publish = vi.spyOn(server.events, "publish");
  const revision = config().revision;
  now = Date.parse("2026-11-16T19:00:00Z");
  server.scheduler.reconcile();
  const second = server.states.state(id)!;
  expect(second).toMatchObject({
    sceneId: night,
    revision,
    epoch: first.epoch,
  });
  expect(second.sequence).toBeGreaterThan(first.sequence);
  expect(publish).toHaveBeenCalledWith(id, server.store);
  // An editor opened before the automatic transition still has a valid revision.
  await request(`/scenes/${day}`, "PATCH", {
    revision,
    settings: { caption: "Saved while night is active" },
  });
  expect(server.states.state(id)?.sceneId).toBe(night);
});

it("rejects manual activation while scheduled and freezes the current scene when disabled", async () => {
  const day = config().activeSceneId,
    night = await create();
  await enable(day, night);
  await request(`/scenes/${night}/activate`, "POST", {}, 409);
  now = Date.parse("2026-11-16T20:00:00Z");
  await request("/schedule", "PUT", {
    schedule: { ...config().schedule, enabled: false },
  });
  now = Date.parse("2026-11-17T08:00:00Z");
  expect(server.states.state(id)?.sceneId).toBe(night);
  await request(`/scenes/${day}/activate`, "POST");
  expect(server.states.state(id)?.sceneId).toBe(day);
});

it("reconciles sleep, forward/backward clock changes, restart, and timezone edits", async () => {
  const day = config().activeSceneId,
    night = await create();
  await enable(day, night);
  now = Date.parse("2026-11-18T21:00:00Z");
  // State reads reconcile even if the timer has not fired.
  expect(server.states.state(id)?.sceneId).toBe(night);
  now = Date.parse("2026-11-18T18:00:00Z");
  expect(server.states.state(id)?.sceneId).toBe(day);
  const response = await server.app.inject({
    method: "PATCH",
    url: `/api/devices/${id}`,
    headers,
    payload: { revision: config().revision, timezone: "Europe/Helsinki" },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(server.states.state(id)?.sceneId).toBe(night);
  await server.app.close();
  server = await createApp({
    dataDir: directory,
    now: () => now,
    connectorFactory: factory,
  });
  expect(server.states.state(id)?.sceneId).toBe(night);
  expect(config().schedule.enabled).toBe(true);
});

it("wakes at the next boundary and cancels scheduler timers on close", async () => {
  const day = config().activeSceneId,
    night = await create();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  now = Date.parse("2026-11-16T18:59:59Z");
  await enable(day, night);
  const publish = vi.spyOn(server.events, "publish");
  now += 1000;
  await vi.advanceTimersByTimeAsync(1000);
  expect(publish).toHaveBeenCalledWith(id, server.store);
  expect(server.states.state(id)?.sceneId).toBe(night);
  server.scheduler.close();
  publish.mockClear();
  await vi.advanceTimersByTimeAsync(60000);
  expect(publish).not.toHaveBeenCalled();
});

it("protects ownership, references, last scenes, and optimistic revisions", async () => {
  const day = config().activeSceneId;
  await request(`/scenes/${day}`, "DELETE", {}, 409);
  const stale = config().revision;
  const night = await create();
  await request(
    `/scenes/${night}`,
    "PATCH",
    { revision: stale, name: "Stale" },
    409,
  );
  const other = await server.app.inject({
    method: "POST",
    url: "/api/devices",
    headers,
    payload: { name: "Other", timezone: "UTC", faceId: "builtin-digital" },
  });
  const otherScene = server.store.selection(other.json().id)!.sceneId;
  await request(`/scenes/${otherScene}/activate`, "POST", {}, 404);
  await request(
    `/scenes/${otherScene}`,
    "PATCH",
    { name: "Wrong display" },
    404,
  );
  await request(
    "/schedule",
    "PUT",
    {
      schedule: {
        enabled: true,
        entries: [{ days: [1], time: "07:00", sceneId: otherScene }],
      },
    },
    404,
  );
  await enable(day, night);
  await request(`/scenes/${night}`, "DELETE", {}, 409);
  expect(() =>
    server.store.db
      .prepare("UPDATE devices SET manual_scene_id = ? WHERE id = ?")
      .run(otherScene, id),
  ).toThrow();
  const removed = await server.app.inject({
    method: "DELETE",
    url: `/api/devices/${id}`,
    headers,
  });
  expect(removed.statusCode, removed.body).toBe(200);
  expect(server.store.scenes(id)).toEqual([]);
  expect(server.store.schedule(id).entries).toEqual([]);
});

it("rechecks revisions after asynchronous binding validation", async () => {
  const day = config().activeSceneId,
    night = await create();
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const validate = server.integrations.validate.bind(server.integrations);
  const validation = vi
    .spyOn(server.integrations, "validate")
    .mockImplementationOnce(async (...args) => {
      started();
      await blocked;
      return validate(...args);
    });
  const pending = server.app
    .inject({
      method: "PATCH",
      url: `/api/devices/${id}/scenes/${day}`,
      headers,
      payload: {
        revision: config().revision,
        settings: { caption: "A stale draft" },
      },
    })
    .then((response) => response);
  await began;
  await request(`/scenes/${night}/activate`, "POST");
  release();
  expect((await pending).statusCode).toBe(409);
  expect(server.store.scene(id, day)?.settings.caption).toBe("Be here, now.");
  validation.mockRestore();
});

it("counts inactive sibling scenes toward source limits without subscribing to them", async () => {
  const integrationId = "limit-fixture";
  server.store.db
    .prepare(
      "INSERT INTO integrations VALUES (?, 'home-assistant', 'Saved sources', 'http://home.example', '', 0, 1)",
    )
    .run(integrationId);
  for (let scene = 0; scene < 16; scene++) {
    const sceneId = randomUUID();
    server.store.db
      .prepare("INSERT INTO scenes VALUES (?, ?, ?, 'builtin-digital', '{}')")
      .run(sceneId, id, `Saved ${scene}`);
    // Saved bindings can outlive provider availability. Exercise reference
    // accounting separately from discovery and live subscriptions.
    server.store.replaceSceneBindings(
      sceneId,
      Object.fromEntries(
        Array.from({ length: 16 }, (_, input) => [
          `input${input}`,
          { integrationId, sourceId: `sensor.saved_${scene * 16 + input}` },
        ]),
      ),
    );
  }
  server.integrations.reconcile();
  expect(watched).toEqual([]);
  expect(() =>
    server.integrations.checkLimits(
      { roomTemperature: { integrationId, sourceId: "sensor.new" } },
      id,
    ),
  ).toThrow("256");
  expect(() =>
    server.integrations.checkLimits(
      { roomTemperature: { integrationId, sourceId: "sensor.saved_0" } },
      id,
    ),
  ).not.toThrow();
  const target = config().scenes[1].id;
  expect(() =>
    server.integrations.checkLimits(
      { roomTemperature: { integrationId, sourceId: "sensor.new" } },
      undefined,
      target,
    ),
  ).not.toThrow();
});

it("requires administrator authentication and CSRF on scene and schedule routes", async () => {
  expect(
    (await server.app.inject(`/api/devices/${id}/scenes`)).statusCode,
  ).toBe(401);
  const sceneId = config().activeSceneId;
  for (const [method, path, payload] of [
    ["POST", "/scenes", { name: "New", faceId: "builtin-digital" }],
    ["PATCH", `/scenes/${sceneId}`, { name: "Edit" }],
    ["DELETE", `/scenes/${sceneId}`, {}],
    ["POST", `/scenes/${sceneId}/activate`, {}],
    ["PUT", "/schedule", { schedule: { enabled: false, entries: [] } }],
  ] as const) {
    const response = await server.app.inject({
      method,
      url: `/api/devices/${id}${path}`,
      headers: { cookie: headers.cookie },
      payload: { revision: 1, ...payload },
    });
    expect(response.statusCode).toBe(403);
  }
});

it("retains inactive bindings, subscribes only to active sources, and blocks integration deletion", async () => {
  const result = await server.app.inject({
    method: "POST",
    url: "/api/integrations",
    headers,
    payload: {
      type: "home-assistant",
      name: "Home",
      baseUrl: "http://home.example",
      token: "secret",
    },
  });
  const integrationId = result.json().id;
  await expect
    .poll(() => server.integrations.list()[0].status)
    .toBe("connected");
  const day = config().activeSceneId,
    night = await create();
  await request(`/scenes/${day}`, "PATCH", {
    bindings: { roomTemperature: { integrationId, sourceId: "sensor.day" } },
  });
  await request(`/scenes/${night}`, "PATCH", {
    bindings: { roomTemperature: { integrationId, sourceId: "sensor.night" } },
  });
  expect(watched.at(-1)).toEqual(["sensor.day"]);
  await request(`/scenes/${night}/activate`, "POST");
  expect(watched.at(-1)).toEqual(["sensor.night"]);
  expect(server.states.state(id)?.data.roomTemperature.value).toBe(19);
  await request(`/scenes/${day}/activate`, "POST");
  expect(server.states.state(id)?.data.roomTemperature.value).toBe(21);
  expect(server.store.scene(id, night)?.bindings.roomTemperature).toMatchObject(
    {
      sourceId: "sensor.night",
    },
  );
  await enable(day, night);
  const state = server.store.state.bind(server.store);
  const boundary = vi
    .spyOn(server.store, "state")
    .mockImplementationOnce((deviceId, selection) => {
      const base = state(deviceId, selection);
      now = Date.parse("2026-11-16T19:00:00Z");
      return base;
    });
  // Crossing a boundary during projection must not mix A's face with B's
  // bindings, even when both faces declare the same input key.
  const during = server.states.state(id)!;
  expect(during.sceneId).toBe(day);
  expect(during.data.roomTemperature.value).toBe(21);
  boundary.mockRestore();
  expect(server.states.state(id)?.data.roomTemperature.value).toBe(19);
  const deleted = await server.app.inject({
    method: "DELETE",
    url: `/api/integrations/${integrationId}`,
    headers,
  });
  expect(deleted.statusCode).toBe(409);
  // Disabling an integration doesn't block switching to a saved scene.
  await server.app.inject({
    method: "PATCH",
    url: `/api/integrations/${integrationId}`,
    headers,
    payload: { revision: 1, enabled: false },
  });
  await request("/schedule", "PUT", {
    schedule: { ...config().schedule, enabled: false },
  });
  await request(`/scenes/${night}/activate`, "POST");
  expect(server.states.state(id)?.data.roomTemperature.status).toBe(
    "unavailable",
  );
});

it("prevents removing a face referenced only by an inactive scene", async () => {
  expect((await upload(server.app, headers, faceZip())).statusCode).toBe(201);
  const sceneId = await create("Custom", testManifest.id);
  const response = await server.app.inject({
    method: "DELETE",
    url: `/api/faces/${testManifest.id}`,
    headers,
  });
  expect(response.statusCode).toBe(409);
  await request(`/scenes/${sceneId}`, "DELETE");
  expect(
    (
      await server.app.inject({
        method: "DELETE",
        url: `/api/faces/${testManifest.id}`,
        headers,
      })
    ).statusCode,
  ).toBe(200);
});
