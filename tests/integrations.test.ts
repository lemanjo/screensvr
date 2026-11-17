import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { createApp } from "../src/server/app.js";
import { administrator, temporaryDirectory, testManifest } from "./helpers.js";
import { FakeHomeAssistant, fakeToken } from "./fake-home-assistant.js";
import { manifestSchema } from "../src/shared/contracts.js";
import { bindingsSchema, datumSchema } from "../src/shared/face-data.js";
import { allowedAddress, baseUrl } from "../src/server/integrations/network.js";
import {
  HomeAssistant,
  type Reading,
} from "../src/server/integrations/home-assistant.js";
import { normalize } from "../src/server/integrations/normalize.js";
import { Secrets } from "../src/server/secrets.js";

describe("data contracts and normalization", () => {
  it("accepts v2 independently of strict v1 and rejects unsafe inputs", () => {
    const manifest = {
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
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    for (const inputs of [
      [...manifest.inputs, manifest.inputs[0]],
      [{ ...manifest.inputs[0], key: "__proto__" }],
      [{ ...manifest.inputs[0], key: "constructor" }],
      [{ ...manifest.inputs[0], type: "text" }],
      [{ ...manifest.inputs[0], entityId: "sensor.secret" }],
      Array.from({ length: 17 }, (_, i) => ({
        ...manifest.inputs[0],
        key: `input${i}`,
      })),
    ])
      expect(manifestSchema.safeParse({ ...manifest, inputs }).success).toBe(
        false,
      );
    expect(
      manifestSchema.safeParse({ ...manifest, schemaVersion: 1 }).success,
    ).toBe(false);
    expect(
      bindingsSchema.safeParse(
        JSON.parse(
          '{"__proto__":{"integrationId":"anything","sourceId":"sensor.secret"}}',
        ),
      ).success,
    ).toBe(false);
  });
  it("strictly normalizes readings, units, availability and booleans", () => {
    const numeric = (state: string) =>
      normalize("sensor.temperature", {
        state,
        attributes: { device_class: "temperature", unit_of_measurement: "℃" },
        updated: 123,
      })!;
    expect(numeric("21.3").reading).toMatchObject({
      type: "number",
      quantity: "temperature",
      unit: "°C",
      value: 21.3,
      status: "ready",
    });
    for (const value of [
      "",
      " ",
      "21 degrees",
      "1.2.3",
      "NaN",
      "Infinity",
      "1e1000",
      "unknown",
      "unavailable",
    ])
      expect(numeric(value).reading).toMatchObject({
        status: "unavailable",
        value: null,
      });
    expect(
      normalize("binary_sensor.window", {
        state: "off",
        attributes: {},
        updated: null,
      })!.reading.value,
    ).toBe(false);
    expect(
      normalize("binary_sensor.window", {
        state: "unknown",
        attributes: {},
        updated: null,
      })!.reading.value,
    ).toBe(null);
    expect(
      normalize("sensor.text", {
        state: "a".repeat(201),
        attributes: {},
        updated: null,
      })!.reading.status,
    ).toBe("unavailable");
    expect(
      normalize("light.kitchen", {
        state: "on",
        attributes: {},
        updated: null,
      }),
    ).toBeUndefined();
    expect(
      datumSchema.safeParse({ ...numeric("21").reading, value: "21" }).success,
    ).toBe(false);
    expect(
      datumSchema.safeParse({ ...numeric("21").reading, unit: "%" }).success,
    ).toBe(false);
  });
  it("allows explicit LAN/loopback destinations but rejects credential URLs and metadata targets", () => {
    expect(baseUrl("http://homeassistant.local:8123/")).toBe(
      "http://homeassistant.local:8123",
    );
    expect(baseUrl("https://example.com/ha/")).toBe("https://example.com/ha");
    for (const address of [
      "127.0.0.1",
      "192.168.1.2",
      "10.0.0.3",
      "::1",
      "fd00::1",
    ])
      expect(allowedAddress(address)).toBe(true);
    for (const address of [
      "169.254.169.254",
      "0.0.0.0",
      "224.0.0.1",
      "100.100.100.200",
      "::",
      "fe80::1",
      "ff02::1",
      "::ffff:169.254.169.254",
    ])
      expect(allowedAddress(address), address).toBe(false);
    for (const url of [
      "file:///secret",
      "http://user:password@homeassistant.local",
      "http://host/?token=secret",
      "http://host/#secret",
      "http://169.254.169.254",
    ])
      expect(() => baseUrl(url)).toThrow();
  });
});

describe("Home Assistant connector", () => {
  let fake: FakeHomeAssistant;
  let client: Awaited<ReturnType<typeof HomeAssistant.connect>> | undefined;
  beforeEach(async () => {
    fake = await FakeHomeAssistant.start();
  });
  afterEach(async () => {
    client?.close();
    await fake.close();
  });
  it("uses filtered snapshots, compact changes/removals, and read commands only", async () => {
    client = await HomeAssistant.connect(fake.url, fakeToken, () => {});
    const discover = await client.discover();
    expect(
      discover.some((source) => source.id === "binary_sensor.window"),
    ).toBe(true);
    let current = new Map<string, Reading>();
    const watch = client.watch(["sensor.living_room_temperature"], (values) => {
      current = values;
    });
    await watch.ready;
    expect(current.get("sensor.living_room_temperature")?.reading.value).toBe(
      21.3,
    );
    expect(current.size).toBe(1);
    fake.set("sensor.living_room_temperature", "22.8");
    await vi.waitFor(() =>
      expect(current.get("sensor.living_room_temperature")?.reading.value).toBe(
        22.8,
      ),
    );
    fake.removeAttribute(
      "sensor.living_room_temperature",
      "unit_of_measurement",
    );
    await vi.waitFor(() =>
      expect(
        current.get("sensor.living_room_temperature")?.source.quantity,
      ).toBeUndefined(),
    );
    fake.remove("sensor.living_room_temperature");
    await vi.waitFor(() => expect(current.size).toBe(0));
    watch.close();
    await client.confirm();
    expect(
      fake.commands.every((command) =>
        [
          "get_states",
          "subscribe_entities",
          "unsubscribe_events",
          "ping",
        ].includes(command.type),
      ),
    ).toBe(true);
    expect(
      fake.commands.find((command) => command.type === "subscribe_entities")
        ?.entity_ids,
    ).toEqual(["sensor.living_room_temperature"]);
  });
  it("connects using the checked DNS result with IPv4/IPv6 fallback", async () => {
    client = await HomeAssistant.connect(
      fake.url.replace("127.0.0.1", "localhost"),
      fakeToken,
      () => {},
    );
    await client.confirm();
  });
  it("refuses redirects without forwarding the token to a different destination", async () => {
    const redirect = createServer();
    redirect.on("upgrade", (_request, socket) =>
      socket.end(
        `HTTP/1.1 302 Found\r\nLocation: ${fake.url.replace("http:", "ws:")}/api/websocket\r\nContent-Length: 0\r\n\r\n`,
      ),
    );
    redirect.listen(0, "127.0.0.1");
    await once(redirect, "listening");
    const address = redirect.address();
    if (!address || typeof address === "string")
      throw new Error("Missing redirect fixture address.");
    try {
      await expect(
        HomeAssistant.connect(
          `http://127.0.0.1:${address.port}`,
          fakeToken,
          () => {},
        ),
      ).rejects.toThrow("Cannot connect");
      expect(fake.connections).toBe(0);
    } finally {
      await new Promise<void>((resolve) => redirect.close(() => resolve()));
    }
  });
  it("rejects authentication and does not echo upstream errors", async () => {
    await expect(
      HomeAssistant.connect(fake.url, "bad-token", () => {}),
    ).rejects.toThrow("rejected the access token");
  });
  it("rejects an upstream that ignores selected entity filtering", async () => {
    fake.unfiltered = true;
    client = await HomeAssistant.connect(fake.url, fakeToken, () => {});
    const callback = vi.fn();
    const watch = client.watch(["sensor.living_room_temperature"], callback);
    await expect(watch.ready).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
  });
  it("closes a pending initial subscription without waiting for its deadline", async () => {
    fake.rejectSubscriptions = true;
    client = await HomeAssistant.connect(fake.url, fakeToken, () => {});
    const watch = client.watch(["sensor.living_room_temperature"], () => {});
    await expect(watch.ready).rejects.toThrow("refused");
    watch.close();
    client.close();
  });
});

describe("integration management and display isolation", () => {
  let fake: FakeHomeAssistant;
  let server: Awaited<ReturnType<typeof createApp>>;
  let directory: string;
  let headers: Awaited<ReturnType<typeof administrator>>;
  beforeEach(async () => {
    fake = await FakeHomeAssistant.start();
    directory = await temporaryDirectory("screensvr-integrations-");
    server = await createApp({ dataDir: directory });
    headers = await administrator(server.app);
  });
  afterEach(async () => {
    await server?.app.close();
    await fake?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function connection() {
    const response = await server.app.inject({
      method: "POST",
      url: "/api/integrations",
      headers,
      payload: {
        name: "My home",
        type: "home-assistant",
        baseUrl: fake.url,
        token: fakeToken,
      },
    });
    expect(response.statusCode).toBe(201);
    const integration = response.json();
    await vi.waitFor(() =>
      expect(server.integrations.list()[0]?.status).toBe("connected"),
    );
    return integration.id as string;
  }
  async function device(name = "Living room", faceId = "builtin-digital") {
    const response = await server.app.inject({
      method: "POST",
      url: "/api/devices",
      headers,
      payload: { name, timezone: "UTC", faceId },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }
  function state(id: string) {
    return server.states.state(id)!;
  }
  async function bind(
    id: string,
    integrationId: string,
    sourceId = "sensor.living_room_temperature",
  ) {
    return server.app.inject({
      method: "PATCH",
      url: `/api/devices/${id}`,
      headers,
      payload: {
        revision: state(id).revision,
        bindings: { roomTemperature: { integrationId, sourceId } },
      },
    });
  }
  it("protects every new management operation with admin, CSRF, and origin checks", async () => {
    for (const [method, url] of [
      ["GET", "/api/integrations"],
      ["POST", "/api/integrations"],
      ["PATCH", "/api/integrations/anything"],
      ["DELETE", "/api/integrations/anything"],
      ["POST", "/api/integrations/test"],
      ["POST", "/api/integrations/anything/test"],
      ["GET", "/api/integrations/anything/sources"],
      ["POST", "/api/devices/anything/preview"],
    ] as const) {
      expect((await server.app.inject({ method, url })).statusCode).toBe(401);
      if (method !== "GET") {
        expect(
          (
            await server.app.inject({
              method,
              url,
              headers: { cookie: headers.cookie },
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await server.app.inject({
              method,
              url,
              headers: { ...headers, origin: "https://evil.invalid" },
            })
          ).statusCode,
        ).toBe(403);
      }
    }
  });
  it.each(["builtin-digital", "builtin-stillroom"])(
    "%s previews without saving and only exposes selected values on each display",
    async (faceId) => {
      const integrationId = await connection();
      const first = await device("Living room", faceId);
      const second = await device("Bedroom", faceId);
      const preview = await server.app.inject({
        method: "POST",
        url: `/api/devices/${first}/preview`,
        headers,
        payload: {
          faceId,
          bindings: {
            roomTemperature: {
              integrationId,
              sourceId: "sensor.living_room_temperature",
            },
          },
        },
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().data.roomTemperature.value).toBe(21.3);
      expect(state(first).data.roomTemperature.status).toBe("unbound");
      expect(server.store.bindings(first)).toEqual({});
      expect((await bind(first, integrationId)).statusCode).toBe(200);
      expect(
        (await bind(second, integrationId, "sensor.bedroom_temperature"))
          .statusCode,
      ).toBe(200);
      await vi.waitFor(() => {
        expect(state(first).data.roomTemperature.value).toBe(21.3);
        expect(state(second).data.roomTemperature.value).toBe(19.2);
      });
      expect(fake.connections).toBe(1);
      const sequence = state(first).sequence;
      const writes = server.store.db
        .prepare("SELECT total_changes() AS count")
        .get()!.count;
      fake.set("sensor.living_room_temperature", "22.4");
      await vi.waitFor(() =>
        expect(state(first).data.roomTemperature.value).toBe(22.4),
      );
      expect(state(second).data.roomTemperature.value).toBe(19.2);
      expect(state(first).revision).toBe(2);
      expect(state(first).sequence).toBeGreaterThan(sequence);
      expect(
        server.store.db.prepare("SELECT total_changes() AS count").get()!.count,
      ).toBe(writes);
      const response = await server.app.inject(
        "/api/display/living-room/state",
      );
      for (const forbidden of [
        fakeToken,
        fake.url,
        integrationId,
        "sensor.living_room_temperature",
        "sensor.secret",
        "DO NOT EXPOSE",
      ])
        expect(response.body).not.toContain(forbidden);
      const adminRead = await server.app.inject({
        url: "/api/integrations",
        headers,
      });
      expect(adminRead.body).not.toContain(fakeToken);
      expect(adminRead.body).not.toContain(
        server.store.integration(integrationId)!.credentials,
      );
      expect(
        server.store.integration(integrationId)!.credentials,
      ).not.toContain(fakeToken);
      expect(
        (await stat(path.join(directory, "integration-key"))).mode & 0o777,
      ).toBe(0o600);
      expect(
        (await stat(path.join(directory, "screensvr.sqlite"))).mode & 0o777,
      ).toBe(0o600);
    },
  );
  it("validates bindings, clears them on face changes, and prevents stale saves", async () => {
    const integrationId = await connection();
    const id = await device();
    expect(
      (await bind(id, integrationId, "binary_sensor.window")).statusCode,
    ).toBe(400);
    expect((await bind(id, integrationId, "sensor.secret")).statusCode).toBe(
      400,
    );
    expect(
      (await bind(id, integrationId, "sensor.does_not_exist")).statusCode,
    ).toBe(400);
    expect((await bind(id, integrationId)).statusCode).toBe(200);
    const stale = await server.app.inject({
      method: "PATCH",
      url: `/api/devices/${id}`,
      headers,
      payload: { revision: 1, name: "Stale" },
    });
    expect(stale.statusCode).toBe(409);
    expect(
      (
        await server.app.inject({
          method: "PATCH",
          url: `/api/devices/${id}`,
          headers,
          payload: { revision: 2, faceId: "builtin-analog" },
        })
      ).statusCode,
    ).toBe(200);
    expect(server.store.bindings(id)).toEqual({});
    expect(state(id).data).toEqual({});
    await server.app.inject({
      method: "PATCH",
      url: `/api/devices/${id}`,
      headers,
      payload: { revision: 3, faceId: "builtin-digital" },
    });
    expect(state(id).data.roomTemperature.status).toBe("unbound");
  });
  it("restricts deletion, disables data immediately, and retains existing bindings during outages", async () => {
    const integrationId = await connection();
    const id = await device();
    await bind(id, integrationId);
    await vi.waitFor(() =>
      expect(state(id).data.roomTemperature.status).toBe("ready"),
    );
    expect(
      (
        await server.app.inject({
          method: "DELETE",
          url: `/api/integrations/${integrationId}`,
          headers,
        })
      ).statusCode,
    ).toBe(409);
    const credentials = server.store.integration(integrationId)!.credentials;
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
    expect(server.store.integration(integrationId)!.credentials).toBe(
      credentials,
    );
    expect(state(id).data.roomTemperature).toMatchObject({
      status: "unavailable",
      value: null,
    });
    expect(
      (
        await server.app.inject({
          method: "PATCH",
          url: `/api/devices/${id}`,
          headers,
          payload: { revision: 2, name: "Renamed" },
        })
      ).statusCode,
    ).toBe(200);
    expect(Object.keys(server.store.bindings(id))).toHaveLength(1);
    expect(
      (
        await server.app.inject({
          method: "PATCH",
          url: `/api/integrations/${integrationId}`,
          headers,
          payload: { revision: 1, enabled: true },
        })
      ).statusCode,
    ).toBe(409);
    await server.app.inject({
      method: "DELETE",
      url: `/api/devices/${id}`,
      headers,
    });
    expect(server.store.usage(integrationId)).toEqual([]);
    expect(
      (
        await server.app.inject({
          method: "DELETE",
          url: `/api/integrations/${integrationId}`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
  });
  it("marks disconnected values stale, refreshes them on reconnect, and clears removed sources", async () => {
    const integrationId = await connection();
    const id = await device();
    await bind(id, integrationId);
    await vi.waitFor(() =>
      expect(state(id).data.roomTemperature.status).toBe("ready"),
    );
    fake.disconnect();
    await vi.waitFor(() =>
      expect(state(id).data.roomTemperature.status).toBe("stale"),
    );
    fake.set("sensor.living_room_temperature", "24");
    await vi.waitFor(
      () =>
        expect(state(id).data.roomTemperature).toMatchObject({
          status: "ready",
          value: 24,
        }),
      { timeout: 4000 },
    );
    fake.remove("sensor.living_room_temperature");
    await vi.waitFor(() =>
      expect(state(id).data.roomTemperature).toMatchObject({
        status: "unavailable",
        value: null,
      }),
    );
  });
  it("does not regenerate a missing key or stop unrelated faces on restart", async () => {
    await connection();
    const id = await device();
    await server.app.close();
    await rm(path.join(directory, "integration-key"));
    server = await createApp({ dataDir: directory });
    expect(server.integrations.list()[0]).toMatchObject({
      status: "error",
      error: expect.stringContaining("key is missing"),
    });
    expect(state(id).data.roomTemperature.status).toBe("unbound");
    await expect(
      stat(path.join(directory, "integration-key")),
    ).rejects.toThrow();
  });
  it("restores bindings and credentials from a complete stopped-server backup", async () => {
    const integrationId = await connection();
    const id = await device();
    await bind(id, integrationId);
    await vi.waitFor(() =>
      expect(state(id).data.roomTemperature.status).toBe("ready"),
    );
    const epoch = state(id).epoch;
    const backup = await temporaryDirectory("screensvr-integration-backup-");
    try {
      await server.app.close();
      await cp(directory, backup, { recursive: true });
      server = await createApp({ dataDir: backup });
      await vi.waitFor(() =>
        expect(state(id).data.roomTemperature).toMatchObject({
          status: "ready",
          value: 21.3,
        }),
      );
      expect(state(id).epoch).not.toBe(epoch);
      expect(state(id).revision).toBe(2);
      expect(server.store.bindings(id).roomTemperature).toEqual({
        integrationId,
        sourceId: "sensor.living_room_temperature",
      });
    } finally {
      await server.app.close();
      await rm(backup, { recursive: true, force: true });
    }
  });
  it("encrypts secrets with authenticated ciphertext and a restorable key", async () => {
    const secrets = new Secrets(directory, false);
    const encoded = secrets.encrypt(fakeToken);
    expect(secrets.decrypt(encoded)).toBe(fakeToken);
    expect(() => secrets.decrypt(encoded.replace(/^v1/, "v9"))).toThrow(
      "cannot be decrypted",
    );
    const tampered = encoded.split(".");
    const tag = Buffer.from(tampered[2], "base64");
    tag[0] ^= 1;
    tampered[2] = tag.toString("base64");
    expect(() => secrets.decrypt(tampered.join("."))).toThrow(
      "cannot be decrypted",
    );
    const key = await readFile(path.join(directory, "integration-key"));
    await writeFile(path.join(directory, "integration-key"), key);
    expect(new Secrets(directory, true).decrypt(encoded)).toBe(fakeToken);
  });
});
