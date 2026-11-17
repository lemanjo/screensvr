import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { manifestSchema, validateSettings } from "../src/shared/contracts.js";
import {
  compatible,
  datumSchema,
  emptyDatum,
  type FaceData,
} from "../src/shared/face-data.js";
import { frameData } from "../web/src/face-data.js";
import {
  currentWeather,
  forecastReading,
  FORECAST_REFRESH,
  weatherSources,
} from "../src/server/integrations/weather.js";
import { Forecasts } from "../src/server/integrations/forecasts.js";
import { HomeAssistant } from "../src/server/integrations/home-assistant.js";
import { createApp } from "../src/server/app.js";
import { FakeHomeAssistant, fakeToken } from "./fake-home-assistant.js";
import { administrator, temporaryDirectory } from "./helpers.js";
import type { Reading } from "../src/server/integrations/connector.js";
import weatherManifest from "../faces/builtin-weather/manifest.json" with { type: "json" };

const now = Date.parse("2026-11-17T12:00:00Z");
const state = {
  state: "rainy",
  attributes: {
    friendly_name: "Home",
    temperature: 12.5,
    temperature_unit: "°C",
    supported_features: 3,
    secret: "must not leave the server",
  },
  updated: now,
};
const rows = [
  {
    datetime: "2026-11-17T00:00:00Z",
    condition: "rainy",
    temperature: 15,
    templow: 7,
  },
  {
    datetime: "2026-11-18T00:00:00Z",
    condition: "cloudy",
    temperature: 13,
    templow: 6,
  },
];
afterEach(() => vi.useRealTimers());

describe("weather contracts and normalization", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  it("requires v4 for structured inputs and matches daily/hourly sources independently", () => {
    expect(manifestSchema.safeParse(weatherManifest).success).toBe(true);
    for (const schemaVersion of [1, 2, 3])
      expect(
        manifestSchema.safeParse({ ...weatherManifest, schemaVersion }).success,
      ).toBe(false);
    const daily = {
      key: "daily",
      label: "Daily",
      type: "forecast" as const,
      period: "daily" as const,
    };
    const sources = weatherSources("weather.home", state);
    expect(sources.map((source) => source.id)).toEqual([
      "weather.home",
      "weather.home:daily",
      "weather.home:hourly",
    ]);
    expect(compatible(daily, sources[1])).toBe(true);
    expect(compatible(daily, sources[2])).toBe(false);
    expect(emptyDatum(daily)).toMatchObject({ period: "daily", value: null });
    expect(weatherSources("light.home", state)).toEqual([]);
    expect(weatherSources("weather.home:daily", state)).toEqual([]);
    expect(
      weatherSources("weather.home", { ...state, attributes: {} }),
    ).toHaveLength(1);
  });
  it("normalizes current conditions without inventing temperatures or unknown conditions", () => {
    expect(currentWeather("weather.home", state).reading).toMatchObject({
      type: "weather",
      value: { temperature: 12.5, condition: "rain" },
      unit: "°C",
    });
    for (const temperature of [undefined, NaN, Infinity, "12.5"]) {
      const reading = currentWeather("weather.home", {
        ...state,
        attributes: { ...state.attributes, temperature },
      }).reading;
      expect(reading.value).toEqual({ temperature: null, condition: "rain" });
      expect(datumSchema.safeParse(reading).success).toBe(true);
    }
    const partial = currentWeather("weather.home", {
      ...state,
      state: "something-unrecognized",
    }).reading;
    expect(partial.value).toEqual({ temperature: 12.5, condition: null });
    for (const value of ["unknown", "unavailable"])
      expect(
        currentWeather("weather.home", { ...state, state: value }).reading,
      ).toMatchObject({ status: "unavailable", value: null });
    expect(
      currentWeather("weather.home", {
        ...state,
        state: "constructor",
        updated: -1,
        attributes: { temperature: 4, temperature_unit: "bogus" },
      }).reading,
    ).toMatchObject({ status: "unavailable", value: null, updatedAt: null });
  });
  it("sorts, deduplicates, bounds and sanitizes forecasts while preserving missing fields", () => {
    const reading = forecastReading("weather.home", "daily", state, [
      rows[1],
      rows[0],
      rows[0],
      { ...rows[0], datetime: "2026-02-30T00:00:00Z" },
      { ...rows[0], datetime: "not-a-date" },
      { ...rows[0], datetime: "2026-11-19" },
      {
        ...rows[0],
        datetime: "2026-11-19T00:00:00Z",
        temperature: NaN,
        templow: null,
        condition: "sunny",
      },
    ]).reading;
    expect(reading.updatedAt).toBeNull();
    expect(reading.value).toEqual({
      entries: [
        {
          at: Date.parse(rows[0].datetime),
          condition: "rain",
          temperature: 15,
          low: 7,
        },
        {
          at: Date.parse(rows[1].datetime),
          condition: "cloudy",
          temperature: 13,
          low: 6,
        },
        {
          at: Date.parse("2026-11-19T00:00:00Z"),
          condition: "clear-day",
          temperature: null,
          low: null,
        },
      ],
    });
    expect(datumSchema.safeParse(reading).success).toBe(true);
    for (const value of [null, [], {}, Array(1001).fill(rows[0])])
      expect(
        forecastReading("weather.home", "daily", state, value).reading,
      ).toMatchObject({ status: "unavailable", value: null });
    const long = Array.from({ length: 80 }, (_, index) => ({
      ...rows[0],
      datetime: new Date(now + index * 3600000).toISOString(),
    }));
    const hourly = forecastReading(
      "weather.home",
      "hourly",
      state,
      long,
    ).reading;
    expect(hourly.value).toHaveProperty("entries.length", 24);
    expect(datumSchema.safeParse(hourly).success).toBe(true);
    expect(JSON.stringify(hourly)).not.toContain("templow");
  });
  it("rejects invalid structured readings and projects only whitelisted nested fields", () => {
    const face = manifestSchema.parse(weatherManifest);
    const weather = currentWeather("weather.home", state).reading;
    const daily = forecastReading("weather.home", "daily", state, rows).reading;
    const data: FaceData = { weather, daily };
    const projected = frameData(face, data);
    expect(projected.hourly).toMatchObject({
      status: "unbound",
      period: "hourly",
    });
    expect(projected.daily).toMatchObject({ status: "ready" });
    for (const reading of [
      { ...weather, value: { temperature: 4, condition: "invented" } },
      { ...weather, unit: null },
      { ...daily, period: undefined },
      { ...daily, period: "hourly" },
      { ...daily, value: { entries: [] } },
      {
        ...daily,
        value: {
          entries: Array(8).fill({
            at: now,
            temperature: 1,
            low: 0,
            condition: null,
          }),
        },
      },
    ])
      expect(datumSchema.safeParse(reading).success).toBe(false);
    const unsafe = JSON.parse(JSON.stringify(data));
    unsafe.weather.value.secret = "sensitive";
    unsafe.daily.value.entries[0].entity_id = "weather.private";
    unsafe.extra = weather;
    const serialized = JSON.stringify(frameData(face, unsafe));
    expect(serialized).not.toMatch(
      /sensitive|weather\.private|entity_id|extra/,
    );
    expect(
      frameData(face, { daily: { ...daily, period: "hourly" } }).daily.status,
    ).toBe("unavailable");
  });
});

describe("shared forecast lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  it("shares subscriptions, re-confirms on a bounded schedule and retains stale failures", async () => {
    let reject = false;
    const close = vi.fn();
    const subscribe = vi.fn((_id, _period, callback) => {
      if (!reject) callback(rows);
      return {
        ready: reject
          ? Promise.reject(new Error("No forecast"))
          : Promise.resolve(),
        close,
      };
    });
    const pool = new Forecasts(subscribe);
    const first = pool.acquire("weather.home", "daily", state, vi.fn());
    const second = pool.acquire("weather.home", "daily", state, vi.fn());
    await first.ready;
    expect(subscribe).toHaveBeenCalledOnce();
    expect(first.reading.reading.status).toBe("ready");
    expect(first.reading.validUntil).toBe(now + 3600000);
    first.close();
    expect(close).not.toHaveBeenCalled();
    reject = true;
    await vi.advanceTimersByTimeAsync(FORECAST_REFRESH);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(second.reading.reading).toMatchObject({
      status: "stale",
      value: { entries: expect.any(Array) },
    });
    second.close();
    const count = subscribe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(FORECAST_REFRESH * 2);
    expect(subscribe).toHaveBeenCalledTimes(count);
    pool.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clears unavailable entities and invalidates old forecast values on unit changes", async () => {
    const callbacks: ((forecast: unknown) => void)[] = [];
    const pool = new Forecasts((_id, _period, callback) => {
      callbacks.push(callback);
      callback(rows);
      return { ready: Promise.resolve(), close: vi.fn() };
    });
    const handle = pool.acquire("weather.home", "daily", state, vi.fn());
    await handle.ready;
    handle.update({
      ...state,
      attributes: { ...state.attributes, temperature_unit: "°F" },
    });
    callbacks[0](rows);
    expect(handle.reading.source.unit).toBe("°F");
    handle.update({ ...state, state: "unavailable" });
    expect(handle.reading.reading).toMatchObject({
      status: "unavailable",
      value: null,
    });
    callbacks.at(-1)!(rows);
    expect(handle.reading.reading.value).toBeNull();
    handle.close();
    pool.close();
  });
  it("limits concurrent initial reads and cancels queued work when consumers leave", async () => {
    const resolves: (() => void)[] = [];
    const subscribe = vi.fn(() => ({
      ready: new Promise<void>((resolve) => resolves.push(resolve)),
      close: () => resolves.shift()?.(),
    }));
    const pool = new Forecasts(subscribe);
    const handles = Array.from({ length: 12 }, (_, index) =>
      pool.acquire(`weather.home_${index}`, "daily", state, vi.fn()),
    );
    expect(subscribe).toHaveBeenCalledTimes(4);
    for (const handle of handles) handle.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(subscribe).toHaveBeenCalledTimes(4);
    pool.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds initial preview readiness even when a forecast never arrives", async () => {
    let reject!: (error: Error) => void;
    const pool = new Forecasts(() => ({
      ready: new Promise<void>((_resolve, no) => {
        reject = no;
      }),
      close: () => reject(new Error("Cancelled")),
    }));
    const changed = vi.fn();
    const handle = pool.acquire("weather.home", "daily", state, changed);
    expect(handle.reading.reading.status).toBe("loading");
    await vi.advanceTimersByTimeAsync(10000);
    await handle.ready;
    expect(handle.reading.reading).toMatchObject({
      status: "unavailable",
      value: null,
    });
    expect(changed).toHaveBeenCalled();
    handle.close();
    pool.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Home Assistant weather transport", () => {
  let fake: FakeHomeAssistant;
  let client: Awaited<ReturnType<typeof HomeAssistant.connect>>;
  beforeEach(async () => {
    fake = await FakeHomeAssistant.start();
    client = await HomeAssistant.connect(fake.url, fakeToken, () => {});
  });
  afterEach(async () => {
    client.close();
    await fake.close();
  });
  it("filters physical entities and independently streams selected forecasts using read commands only", async () => {
    const sources = await client.discover();
    expect(
      sources.filter((source) => source.id.startsWith("weather.")),
    ).toHaveLength(3);
    let current = new Map<string, Reading>();
    const watch = client.watch(
      ["weather.home", "weather.home:daily"],
      (values) => {
        current = values;
      },
    );
    await watch.ready;
    expect(current.get("weather.home")?.reading.value).toEqual({
      temperature: 12.5,
      condition: "rain",
    });
    expect(current.get("weather.home:daily")?.reading.status).toBe("ready");
    expect(
      fake.commands.find((command) => command.type === "subscribe_entities")
        ?.entity_ids,
    ).toEqual(["weather.home"]);
    expect(
      fake.commands.filter(
        (command) => command.type === "weather/subscribe_forecast",
      ),
    ).toEqual([
      {
        type: "weather/subscribe_forecast",
        entity_id: "weather.home",
        forecast_type: "daily",
      },
    ]);
    fake.setForecast("weather.home", "daily", null);
    await vi.waitFor(() =>
      expect(current.get("weather.home:daily")?.reading.status).toBe(
        "unavailable",
      ),
    );
    expect(current.get("weather.home")?.reading.status).toBe("ready");
    fake.set("weather.home", "snowy", {
      friendly_name: "Home",
      temperature: -2,
      temperature_unit: "°C",
      supported_features: 3,
    });
    await vi.waitFor(() =>
      expect(current.get("weather.home")?.reading.value).toEqual({
        temperature: -2,
        condition: "snow",
      }),
    );
    fake.set("weather.home", "snowy", {
      temperature: null,
      temperature_unit: "°C",
      supported_features: 3,
    });
    await vi.waitFor(() =>
      expect(current.get("weather.home")?.reading.value).toEqual({
        temperature: null,
        condition: "snow",
      }),
    );
    watch.close();
    await vi.waitFor(() => expect(fake.activeForecasts).toBe(0));
    expect(
      fake.commands.every((command) =>
        [
          "get_states",
          "subscribe_entities",
          "weather/subscribe_forecast",
          "unsubscribe_events",
        ].includes(command.type),
      ),
    ).toBe(true);
    expect(JSON.stringify([...current.values()])).not.toContain(
      "DO NOT EXPOSE",
    );
  });
  it("shares forecast reads with overlapping previews, and rejected forecasts do not break sensors", async () => {
    const first = client.watch(["weather.home:hourly"], () => {});
    await first.ready;
    const preview = client.watch(["weather.home:hourly"], () => {});
    await preview.ready;
    expect(
      fake.commands.filter(
        (command) => command.type === "weather/subscribe_forecast",
      ),
    ).toHaveLength(1);
    preview.close();
    expect(fake.activeForecasts).toBe(1);
    first.close();
    await vi.waitFor(() => expect(fake.activeForecasts).toBe(0));
    fake.rejectForecasts = true;
    let current = new Map<string, Reading>();
    const watch = client.watch(
      ["weather.home:daily", "sensor.humidity"],
      (values) => {
        current = values;
      },
    );
    await watch.ready;
    expect(current.get("weather.home:daily")?.reading.status).toBe(
      "unavailable",
    );
    expect(current.get("sensor.humidity")?.reading.status).toBe("ready");
    await client.confirm();
    watch.close();
  });
  it("clears deleted weather entities, including their previously selected forecasts", async () => {
    let current = new Map<string, Reading>();
    const watch = client.watch(["weather.home:daily"], (values) => {
      current = values;
    });
    await watch.ready;
    fake.remove("weather.home");
    await vi.waitFor(() =>
      expect(current.get("weather.home:daily")?.reading.value).toBeNull(),
    );
    await vi.waitFor(() => expect(fake.activeForecasts).toBe(0));
    watch.close();
  });
});

describe("weather management and display boundary", () => {
  let fake: FakeHomeAssistant;
  let server: Awaited<ReturnType<typeof createApp>>;
  let directory: string;
  let headers: Awaited<ReturnType<typeof administrator>>;
  beforeEach(async () => {
    fake = await FakeHomeAssistant.start();
    directory = await temporaryDirectory("screensvr-weather-");
    server = await createApp({ dataDir: directory });
    headers = await administrator(server.app);
  });
  afterEach(async () => {
    await server.app.close();
    await fake.close();
    await rm(directory, { recursive: true, force: true });
  });
  it("restores saved weather scenes after restart without reading inactive forecasts", async () => {
    const connection = await server.app.inject({
      method: "POST",
      url: "/api/integrations",
      headers,
      payload: {
        type: "home-assistant",
        name: "Home",
        baseUrl: fake.url,
        token: fakeToken,
      },
    });
    const integrationId = connection.json().id;
    await vi.waitFor(() =>
      expect(server.integrations.list()[0].status).toBe("connected"),
    );
    const created = await server.app.inject({
      method: "POST",
      url: "/api/devices",
      headers,
      payload: {
        name: "Scenes",
        timezone: "Asia/Kathmandu",
        faceId: "builtin-digital",
      },
    });
    const id = created.json().id;
    const original = server.states.state(id)!.sceneId;
    const bindings = {
      weather: { integrationId, sourceId: "weather.home" },
      hourly: { integrationId, sourceId: "weather.home:hourly" },
    };
    const scene = await server.app.inject({
      method: "POST",
      url: `/api/devices/${id}/scenes`,
      headers,
      payload: {
        revision: 1,
        name: "Weather",
        faceId: "builtin-weather",
        bindings,
        settings: { forecast: "hourly", motion: false },
      },
    });
    expect(scene.statusCode).toBe(201);
    const weatherScene = scene.json().createdSceneId;
    expect(
      fake.commands.some(
        (command) => command.type === "weather/subscribe_forecast",
      ),
    ).toBe(false);
    const activate = (sceneId: string) =>
      server.app.inject({
        method: "POST",
        url: `/api/devices/${id}/scenes/${sceneId}/activate`,
        headers,
        payload: { revision: server.store.device(id)!.revision },
      });
    expect((await activate(weatherScene)).statusCode).toBe(200);
    await vi.waitFor(() =>
      expect(server.states.state(id)!.data.hourly.status).toBe("ready"),
    );
    expect(fake.activeForecasts).toBe(1);
    expect((await activate(original)).statusCode).toBe(200);
    await vi.waitFor(() => expect(fake.activeForecasts).toBe(0));
    await server.app.close();
    server = await createApp({ dataDir: directory });
    await vi.waitFor(() =>
      expect(server.integrations.list()[0].status).toBe("connected"),
    );
    expect(fake.activeForecasts).toBe(0);
    expect(server.store.scene(id, weatherScene)?.bindings).toEqual(bindings);
    expect((await activate(weatherScene)).statusCode).toBe(200);
    await vi.waitFor(() =>
      expect(server.states.state(id)!.data.hourly.status).toBe("ready"),
    );
    expect(server.states.state(id)).toMatchObject({
      face: { id: "builtin-weather" },
      timezone: "Asia/Kathmandu",
      settings: { forecast: "hourly", motion: false },
    });
  });
  it("installs the face, previews without saving and streams only explicitly selected public weather", async () => {
    const face = server.store.face("builtin-weather")!;
    expect(face.builtin).toBe(true);
    expect(validateSettings(face.manifest, {})).toMatchObject({
      motion: true,
      forecast: "daily",
    });
    for (const file of ["index.html", "style.css", "face.js"]) {
      const response = await server.app.inject(
        `/faces/builtin-weather/1.0.0/${file}`,
      );
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-security-policy"]).toContain(
        "connect-src 'none'",
      );
    }
    const connection = await server.app.inject({
      method: "POST",
      url: "/api/integrations",
      headers,
      payload: {
        type: "home-assistant",
        name: "Home",
        baseUrl: fake.url,
        token: fakeToken,
      },
    });
    const integrationId = connection.json().id as string;
    await vi.waitFor(() =>
      expect(server.integrations.list()[0].status).toBe("connected"),
    );
    const found = await server.app.inject({
      url: `/api/integrations/${integrationId}/sources?type=forecast&period=hourly`,
      headers,
    });
    expect(
      found.json().sources.map((source: { id: string }) => source.id),
    ).toEqual(["weather.home:hourly"]);
    const created = await server.app.inject({
      method: "POST",
      url: "/api/devices",
      headers,
      payload: {
        name: "Weather",
        timezone: "Europe/Helsinki",
        faceId: "builtin-weather",
      },
    });
    const { id, displayUrl } = created.json();
    expect(server.states.state(id)!.data.weather.status).toBe("unbound");
    const bindings = {
      weather: { integrationId, sourceId: "weather.home" },
      daily: { integrationId, sourceId: "weather.home:daily" },
      hourly: { integrationId, sourceId: "weather.home:hourly" },
    };
    const preview = await server.app.inject({
      method: "POST",
      url: `/api/devices/${id}/preview`,
      headers,
      payload: { faceId: "builtin-weather", bindings },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.hourly.status).toBe("ready");
    expect(server.states.state(id)!.data.weather.status).toBe("unbound");
    await vi.waitFor(() => expect(fake.activeForecasts).toBe(0));
    const saved = await server.app.inject({
      method: "PATCH",
      url: `/api/devices/${id}`,
      headers,
      payload: { revision: 1, bindings },
    });
    expect(saved.statusCode).toBe(200);
    await vi.waitFor(() =>
      expect(server.states.state(id)!.data.daily.status).toBe("ready"),
    );
    const publicState = await server.app.inject(`/api${displayUrl}/state`);
    expect(publicState.statusCode).toBe(200);
    expect(publicState.body).not.toMatch(
      /weather\.home|DO NOT EXPOSE|private_attribute/,
    );
    expect(publicState.body).not.toContain(fakeToken);
    expect(publicState.body).not.toContain(fake.url);
    fake.rejectAuthentication = true;
    fake.disconnect();
    await vi.waitFor(() =>
      expect(server.states.state(id)!.data.daily.status).toBe("stale"),
    );
    const unbound = await server.app.inject({
      method: "PATCH",
      url: `/api/devices/${id}`,
      headers,
      payload: { revision: server.states.state(id)!.revision, bindings: {} },
    });
    expect(unbound.statusCode).toBe(200);
    expect(server.states.state(id)!.data.daily.value).toBeNull();
  });
});
