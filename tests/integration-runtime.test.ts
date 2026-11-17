import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { Store } from "../src/server/db.js";
import { Integrations } from "../src/server/integrations/manager.js";
import {
  ConnectorError,
  type Connector,
  type ConnectorFactory,
  type Reading,
} from "../src/server/integrations/connector.js";
import { normalize } from "../src/server/integrations/normalize.js";
import type { FaceManifest } from "../src/shared/contracts.js";
import { testManifest, temporaryDirectory } from "./helpers.js";

const face: FaceManifest = {
  ...testManifest,
  schemaVersion: 2,
  inputs: [
    {
      key: "temperature",
      label: "Temperature",
      type: "number",
      quantity: "temperature",
    },
  ],
};
let store: Store;
let integrations: Integrations;
let directory: string;
let integrationId: string;
const clients: {
  client: Connector;
  disconnected: (error: ConnectorError) => void;
  callback?: (values: Map<string, Reading>) => void;
  closed: boolean;
}[] = [];
const factory: ConnectorFactory = async (_url, _token, disconnected) => {
  const item: (typeof clients)[number] = {
    disconnected,
    closed: false,
    client: {
      discover: async () => [],
      confirm: vi.fn(async () => {}),
      close: () => {
        item.closed = true;
      },
      watch: vi.fn(
        (ids: string[], callback: (values: Map<string, Reading>) => void) => {
          item.callback = callback;
          callback(
            new Map(
              ids.map((id) => [
                id,
                normalize(id, {
                  state: id === "sensor.bedroom" ? "19" : "21",
                  attributes: {
                    device_class: "temperature",
                    unit_of_measurement: "°C",
                  },
                  updated: 0,
                })!,
              ]),
            ),
          );
          return { ready: Promise.resolve(), close: vi.fn() };
        },
      ),
    },
  };
  clients.push(item);
  return item.client;
};
beforeEach(async () => {
  directory = await temporaryDirectory("screensvr-runtime-");
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  clients.length = 0;
  store = new Store(":memory:");
  store.db
    .prepare("INSERT INTO faces VALUES (?, ?, 0)")
    .run(face.id, JSON.stringify(face));
  store.db
    .prepare(
      "INSERT INTO devices (id, slug, name, face_id, settings, timezone) VALUES ('room', 'room', 'Room', ?, '{}', 'UTC')",
    )
    .run(face.id);
  integrations = new Integrations(store, directory, vi.fn(), factory);
  integrationId = randomUUID();
  store.db
    .prepare(
      "INSERT INTO integrations (id, type, name, base_url, credentials) VALUES (?, 'home-assistant', 'Home', 'http://localhost', ?)",
    )
    .run(integrationId, integrations.secrets.encrypt("fake-token"));
  store.replaceBindings("room", {
    temperature: { integrationId, sourceId: "sensor.room" },
  });
  integrations.reconcile();
  await vi.advanceTimersByTimeAsync(0);
});
afterEach(async () => {
  integrations.close();
  store.db.close();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});
const data = () => integrations.data(face, store.bindings("room")).temperature;
it("renews the lease on stable values without requiring source last_updated to change", async () => {
  expect(data()).toMatchObject({
    value: 21,
    status: "ready",
    updatedAt: 0,
    expiresAt: 190000,
  });
  await vi.advanceTimersByTimeAsync(30000);
  expect(clients[0].client.confirm).toHaveBeenCalledOnce();
  expect(data()).toMatchObject({
    value: 21,
    status: "ready",
    updatedAt: 0,
    observedAt: 130000,
    expiresAt: 220000,
  });
  expect(store.device("room")?.revision).toBe(1);
});
it("shares concurrent discovery reads instead of requesting the full state repeatedly", async () => {
  const source = normalize("sensor.room", {
    state: "21",
    attributes: { device_class: "temperature", unit_of_measurement: "°C" },
    updated: 0,
  })!.source;
  const discover = vi.fn(async () => [source]);
  clients[0].client.discover = discover;
  const results = await Promise.all(
    Array.from({ length: 16 }, () => integrations.discover(integrationId)),
  );
  expect(discover).toHaveBeenCalledOnce();
  expect(results.every((sources) => sources[0].id === "sensor.room")).toBe(
    true,
  );
});
it("deduplicates sources and ignores stale subscription callbacks after rebinding", () => {
  const oldCallback = clients[0].callback!;
  store.db
    .prepare(
      "INSERT INTO devices (id, slug, name, face_id, settings, timezone) VALUES ('second', 'second', 'Second', ?, '{}', 'UTC')",
    )
    .run(face.id);
  store.replaceBindings("second", {
    temperature: { integrationId, sourceId: "sensor.room" },
  });
  integrations.reconcile();
  expect(clients).toHaveLength(1);
  expect(clients[0].client.watch).toHaveBeenCalledOnce();
  store.replaceBindings("room", {
    temperature: { integrationId, sourceId: "sensor.bedroom" },
  });
  integrations.reconcile();
  expect(data().value).toBe(19);
  oldCallback(new Map());
  expect(data().value).toBe(19);
});
it("does not let an old socket's late failure disconnect a replacement connection", async () => {
  clients[0].disconnected(new ConnectorError("Disconnected."));
  expect(data().status).toBe("stale");
  await vi.advanceTimersByTimeAsync(1300);
  expect(clients).toHaveLength(2);
  expect(data().status).toBe("ready");
  clients[0].disconnected(new ConnectorError("Old late callback."));
  expect(data().status).toBe("ready");
});
it("stops authentication retries, closes replaced clients, and clears disabled readings", async () => {
  clients[0].disconnected(new ConnectorError("Token rejected.", true));
  await vi.advanceTimersByTimeAsync(120000);
  expect(clients).toHaveLength(1);
  expect(integrations.list()[0].status).toBe("authentication-error");
  store.db
    .prepare(
      "UPDATE integrations SET enabled = 0, revision = revision + 1 WHERE id = ?",
    )
    .run(integrationId);
  integrations.reconcile();
  clients[0].callback!(new Map());
  expect(data()).toMatchObject({ value: null, status: "unavailable" });
  expect(clients[0].closed).toBe(true);
});
