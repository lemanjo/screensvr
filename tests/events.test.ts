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
  const { id, displayUrl } = created.json();
  const pair = await app.inject({
    method: "POST",
    url: `/api/display/${id}/pair`,
    payload: { token: displayUrl.split("#")[1] },
  });
  const deviceCookie = `screensvr_display=${pair.cookies[0].value}`;
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  async function stream() {
    const controller = new AbortController();
    const response = await fetch(`${address}/api/display/${id}/events`, {
      headers: { cookie: deviceCookie },
      signal: controller.signal,
    });
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
      method: "POST",
      url: `/api/devices/${id}/pairing`,
      headers,
    });
    expect(await second.state()).toEqual({});
    expect(
      (
        await app.inject({
          url: `/api/display/${id}/state`,
          headers: { cookie: deviceCookie },
        })
      ).statusCode,
    ).toBe(401);
  } finally {
    second.close();
  }
});
