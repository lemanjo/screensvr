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
function sdk(protocols?: number[]) {
  const parent = {};
  const windowEvents = new Map<string, (event: unknown) => void>();
  const documentEvents = new Map<string, () => void>();
  const window = {
    addEventListener: (name: string, callback: (event: unknown) => void) =>
      windowEvents.set(name, callback),
    screensvr: undefined as unknown as {
      onUpdate: (callback: (update: Update) => void) => () => void;
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
