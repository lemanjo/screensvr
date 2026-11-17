import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { frameData } from "../web/src/face-data.js";
import { newerSnapshot } from "../web/src/snapshots.js";
import type { DisplayState } from "../src/shared/contracts.js";
import type { FaceData } from "../src/shared/face-data.js";
import { testManifest } from "./helpers.js";

const source = readFileSync(
  new URL("../public/face-sdk.js", import.meta.url),
  "utf8",
);
type Update = { config: Record<string, unknown>; data: FaceData };
type Photo = { url: string; index: number; count: number; revision: string };
function sdk(protocols?: number[]) {
  const parent = {};
  const windowEvents = new Map<string, (event: unknown) => void>();
  const documentEvents = new Map<string, () => void>();
  const window = {
    addEventListener: (name: string, callback: (event: unknown) => void) =>
      windowEvents.set(name, callback),
    screensvr: undefined as unknown as {
      onUpdate: (callback: (update: Update) => void) => () => void;
      photos: {
        get: (
          key: string,
          options?: { index?: number; width?: number; height?: number },
        ) => Photo | null;
        watch: (
          key: string,
          callback: (photo: Photo | null) => void,
          options?: { interval?: number; shuffle?: boolean },
        ) => () => void;
      };
    },
  };
  const document = {
    addEventListener: (name: string, callback: () => void) =>
      documentEvents.set(name, callback),
  };
  const port = {
    onmessage: undefined as unknown as (event: unknown) => void,
    postMessage: vi.fn(),
    close: vi.fn(),
  };
  runInNewContext(source, {
    window,
    parent,
    document,
    setTimeout,
    clearTimeout,
    Date,
  });
  const connect = (source = parent) =>
    windowEvents.get("message")!({
      source,
      data: { type: "screensvr:connect", ...(protocols ? { protocols } : {}) },
      ports: [port],
    });
  const send = (data: FaceData = {}) =>
    port.onmessage({
      data: {
        type: "update",
        config: { caption: "Quiet" },
        context: { timezone: "UTC" },
        data,
      },
    });
  return { window, connect, send, port, documentEvents };
}
afterEach(() => vi.useRealTimers());
const data = (expiresAt: number): FaceData => ({
  temperature: {
    type: "number",
    quantity: "temperature",
    status: "ready",
    value: 21.3,
    unit: "°C",
    updatedAt: 0,
    observedAt: 0,
    expiresAt,
  },
});
it("negotiates protocols, rejects other senders, preserves late subscribers and unsubscribe", () => {
  const client = sdk([2, 1]);
  client.connect({});
  expect(client.port.postMessage).not.toHaveBeenCalled();
  client.connect();
  expect(client.port.postMessage).toHaveBeenCalledWith({
    type: "ready",
    protocolVersion: 2,
  });
  const first = vi.fn();
  const unsubscribe = client.window.screensvr.onUpdate(first);
  client.send();
  expect(first).toHaveBeenCalledTimes(1);
  const late = vi.fn();
  client.window.screensvr.onUpdate(late);
  expect(late).toHaveBeenCalledWith(
    expect.objectContaining({ config: { caption: "Quiet" }, data: {} }),
  );
  unsubscribe();
  client.send();
  expect(first).toHaveBeenCalledTimes(1);
  const legacy = sdk();
  legacy.connect();
  const update = vi.fn();
  legacy.window.screensvr.onUpdate(update);
  legacy.send(data(Date.now() + 10000));
  expect(legacy.port.postMessage).toHaveBeenCalledWith({
    type: "ready",
    protocolVersion: 1,
  });
  expect(update.mock.calls[0][0].data).toEqual({});
});
it("expires readings locally, handles sleep/resume, and only revives with confirmation", () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const client = sdk([2]);
  client.connect();
  const listener = vi.fn();
  client.window.screensvr.onUpdate(listener);
  client.send(data(190000));
  expect(listener.mock.lastCall![0].data.temperature.status).toBe("ready");
  vi.advanceTimersByTime(90000);
  expect(listener.mock.lastCall![0].data.temperature.status).toBe("stale");
  client.send(data(180000));
  expect(listener.mock.lastCall![0].data.temperature.status).toBe("stale");
  client.send(data(280000));
  expect(listener.mock.lastCall![0].data.temperature.status).toBe("ready");
  vi.setSystemTime(300000);
  client.documentEvents.get("visibilitychange")!();
  expect(listener.mock.lastCall![0].data.temperature.status).toBe("stale");
});
it("isolates callback mutation/errors and allows subsequent listeners to run", () => {
  const client = sdk([2]);
  client.connect();
  client.window.screensvr.onUpdate((update) => {
    update.data.temperature.value = 999;
  });
  const listener = vi.fn();
  client.window.screensvr.onUpdate(listener);
  client.send(data(Date.now() + 1000));
  expect(listener.mock.lastCall![0].data.temperature.value).toBe(21.3);
  expect(client.port.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "error" }),
  );
});
it("bounds frame data to declared inputs and rejects incompatible readings", () => {
  const face = {
    ...testManifest,
    schemaVersion: 2 as const,
    inputs: [
      {
        key: "temperature",
        label: "Temperature",
        type: "number" as const,
        quantity: "temperature" as const,
      },
    ],
  };
  expect(frameData(face).temperature.status).toBe("unbound");
  expect(
    frameData(face, { ...data(1000), private: data(1000).temperature }),
  ).not.toHaveProperty("private");
  expect(
    frameData(face, {
      temperature: { ...data(1000).temperature, value: "bad" },
    }).temperature.status,
  ).toBe("unavailable");
  expect(frameData(testManifest, data(1000))).toEqual({});
});
it("orders data snapshots independently of configuration revision and adopts restart epochs", () => {
  const first = { epoch: "old", sequence: 10, revision: 3 } as DisplayState;
  expect(newerSnapshot(first, { ...first, sequence: 9 })).toBe(first);
  expect(newerSnapshot(first, { ...first, sequence: 11 }).sequence).toBe(11);
  expect(
    newerSnapshot(first, { ...first, epoch: "new", sequence: 1 }).epoch,
  ).toBe("new");
});

const photoData = (count = 3, revision = "a".repeat(64)): FaceData => ({
  photos: {
    type: "image",
    status: "ready",
    value: { count, revision, url: `/api/photos/${"x".repeat(32)}` },
    unit: null,
    updatedAt: 0,
    observedAt: 0,
    expiresAt: Date.now() + 90000,
  },
});
it("negotiates v3 and exposes bounded image URLs without network or provider access", () => {
  const client = sdk([3, 2, 1]);
  client.connect();
  expect(client.port.postMessage).toHaveBeenCalledWith({
    type: "ready",
    protocolVersion: 3,
  });
  expect(client.window.screensvr.photos.get("photos")).toBeNull();
  client.send(photoData());
  const photo = client.window.screensvr.photos.get("photos", {
    index: 2,
    width: 10000,
    height: 500,
  })!;
  expect(photo.index).toBe(2);
  expect(photo.count).toBe(3);
  expect(photo.url).toContain("?index=2&width=2560&height=500&v=");
  expect(Object.isFrozen(photo)).toBe(true);
  for (const index of [-1, 3, 0.5, NaN])
    expect(() =>
      client.window.screensvr.photos.get("photos", { index }),
    ).toThrow();
  expect(() =>
    client.window.screensvr.photos.get("photos", { width: Infinity }),
  ).toThrow();
});
it("rotates photos without restarting on repeated updates, stops on stale data, and unsubscribes", () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const client = sdk([3]);
  client.connect();
  client.send(photoData());
  const callback = vi.fn();
  const stop = client.window.screensvr.photos.watch("photos", callback, {
    interval: 10000,
  });
  expect(callback.mock.lastCall![0].index).toBe(0);
  vi.advanceTimersByTime(5000);
  client.send(photoData());
  vi.advanceTimersByTime(5000);
  expect(callback.mock.lastCall![0].index).toBe(1);
  vi.advanceTimersByTime(10000);
  expect(callback.mock.lastCall![0].index).toBe(2);
  const stale = photoData();
  stale.photos.status = "stale";
  client.send(stale);
  const count = callback.mock.calls.length;
  vi.advanceTimersByTime(20000);
  expect(callback).toHaveBeenCalledTimes(count);
  client.send(photoData(1, "b".repeat(64)));
  expect(callback.mock.lastCall![0].index).toBe(0);
  vi.advanceTimersByTime(20000);
  expect(callback.mock.lastCall![0].index).toBe(0);
  stop();
  client.send(photoData());
  expect(callback.mock.lastCall![0].count).toBe(1);
});
it("shuffles without immediate repeats, resets on collection changes, and clears unavailable photos", () => {
  vi.useFakeTimers();
  const client = sdk([3]);
  client.connect();
  client.send(photoData());
  const callback = vi.fn();
  const stop = client.window.screensvr.photos.watch("photos", callback, {
    interval: 1000,
    shuffle: true,
  });
  for (let i = 0; i < 5; i++) {
    const previous = callback.mock.lastCall![0].index;
    vi.advanceTimersByTime(1000);
    expect(callback.mock.lastCall![0].index).not.toBe(previous);
  }
  const unavailable = photoData();
  unavailable.photos.status = "unavailable";
  unavailable.photos.value = null;
  client.send(unavailable);
  expect(callback.mock.lastCall![0]).toBeNull();
  expect(client.window.screensvr.photos.get("photos")).toBeNull();
  stop();
});
it("bounds v3 frame descriptors to public fields and rejects external image URLs", () => {
  const face = {
    ...testManifest,
    schemaVersion: 3 as const,
    inputs: [{ key: "photos", label: "Photos", type: "image" as const }],
  };
  const data = photoData();
  expect(frameData(face, data).photos.status).toBe("ready");
  const value = data.photos.value as {
    count: number;
    revision: string;
    url: string;
  };
  data.photos.value = { ...value, url: "https://example.com/private.jpg" };
  expect(frameData(face, data).photos.status).toBe("unavailable");
});
