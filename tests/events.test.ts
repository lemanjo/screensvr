import { afterEach, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { createApp } from "../src/server/app.js";
import { administrator, temporaryDirectory } from "./helpers.js";

let server: Awaited<ReturnType<typeof createApp>> | undefined;
let directory: string;
afterEach(async () => {
  await server?.app.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("sends current state on every SSE connection, including after missed changes", async () => {
  directory = await temporaryDirectory("screensvr-events-");
  server = await createApp({ dataDir: directory });
  const { app } = server;
  const headers = await administrator(app);
  const created = await app.inject({
    method: "POST",
    url: "/api/devices",
    headers,
    payload: { name: "Live", timezone: "UTC", faceId: "builtin-digital" },
  });
  const { id } = created.json();
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  async function stream() {
    const controller = new AbortController();
    const response = await fetch(`${address}/api/display/live/events`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let buffer = "";
    async function state() {
      while (true) {
        const separator = buffer.indexOf("\n\n");
        if (separator >= 0) {
          const event = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const data = event
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (data) return JSON.parse(data.slice(6));
        } else {
          const next = await reader.read();
          if (next.done) throw new Error("Stream ended unexpectedly.");
          buffer += new TextDecoder().decode(next.value);
        }
      }
    }
    return { state, close: () => controller.abort() };
  }
  const first = await stream();
  try {
    expect((await first.state()).revision).toBe(1);
    await app.inject({
      method: "PATCH",
      url: `/api/devices/${id}`,
      headers,
      payload: { revision: 1, name: "Updated" },
    });
    expect(await first.state()).toMatchObject({ revision: 2, name: "Updated" });
  } finally {
    first.close();
  }
  await app.inject({
    method: "PATCH",
    url: `/api/devices/${id}`,
    headers,
    payload: { revision: 2, name: "Changed offline" },
  });
  const second = await stream();
  try {
    expect(await second.state()).toMatchObject({
      revision: 3,
      name: "Changed offline",
    });
    await app.inject({
      method: "DELETE",
      url: `/api/devices/${id}`,
      headers,
    });
    expect(await second.state()).toEqual({});
    expect(
      (
        await app.inject({
          url: "/api/display/live/state",
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    second.close();
  }
});

it("ends streams without removing displays during a server restart", async () => {
  directory = await temporaryDirectory("screensvr-events-restart-");
  server = await createApp({ dataDir: directory });
  const headers = await administrator(server.app);
  await server.app.inject({
    method: "POST",
    url: "/api/devices",
    headers,
    payload: { name: "Olohuone", timezone: "UTC", faceId: "builtin-digital" },
  });
  const address = await server.app.listen({ port: 0, host: "127.0.0.1" });
  const response = await fetch(`${address}/api/display/olohuone/events`);
  expect(response.status).toBe(200);
  const stream = response.text();
  await server.app.close();
  const messages = await stream;
  expect(messages).toContain("event: state");
  expect(messages).not.toContain("event: removed");
  server = await createApp({ dataDir: directory });
  expect(
    (await server.app.inject("/api/display/olohuone/state")).json(),
  ).toMatchObject({ displayUrl: "/display/olohuone", name: "Olohuone" });
});
