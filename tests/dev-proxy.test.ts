import { afterEach, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import config from "../vite.config.js";
import { createApp } from "../src/server/app.js";
import { temporaryDirectory } from "./helpers.js";

let backend: Awaited<ReturnType<typeof createApp>> | undefined;
let frontend: ViteDevServer | undefined;
let dataDir: string;
afterEach(async () => {
  await frontend?.close();
  await backend?.app.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

it("accepts same-origin setup through Vite without allowing cross-origin mutations", async () => {
  dataDir = await temporaryDirectory("screensvr-dev-proxy-");
  backend = await createApp({ dataDir });
  const target = await backend.app.listen({ host: "127.0.0.1", port: 0 });
  // Keep the real proxy options, changing only its destination to an isolated
  // backend. A shorthand string must retain Vite's own default behavior.
  const proxy = Object.fromEntries(
    Object.entries(config.server!.proxy!).map(([prefix, options]) => [
      prefix,
      typeof options === "string" ? target : { ...options, target },
    ]),
  );
  frontend = await createServer({
    ...config,
    configFile: false,
    cacheDir: path.join(dataDir, "vite"),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      ...config.server,
      host: "127.0.0.1",
      port: 0,
      strictPort: true,
      hmr: false,
      watch: null,
      proxy,
    },
  });
  await frontend.listen();
  const origin = `http://127.0.0.1:${(frontend.httpServer!.address() as AddressInfo).port}`;
  const setup = (requestOrigin: string) =>
    fetch(`${origin}/api/auth/setup`, {
      method: "POST",
      headers: {
        origin: requestOrigin,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ password: "a-long-dev-test-password" }),
    });

  expect((await setup("https://evil.invalid")).status).toBe(403);
  const response = await setup(origin);
  expect(response.status).toBe(200);
  const { csrf } = (await response.json()) as { csrf: string };
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const logout = await fetch(`${origin}/api/auth/logout`, {
    method: "POST",
    headers: { origin, cookie, "x-csrf-token": csrf },
  });
  expect(logout.status).toBe(200);
  expect(
    (await fetch(`${origin}/faces/builtin-digital/1.2.0/index.html`)).status,
  ).toBe(200);
});
