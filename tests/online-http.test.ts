import https, { type RequestOptions } from "node:https";
import dns from "node:dns";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import {
  OnlineHttp,
  OnlineHttpError,
} from "../src/server/integrations/online-http.js";

afterEach(() => vi.restoreAllMocks());
function transport({
  status = 200,
  type = "application/json",
  body = Buffer.from("{}"),
  headers = {} as Record<string, string>,
} = {}) {
  let options!: RequestOptions;
  const send = vi.spyOn(https, "request").mockImplementation(((
    _url: string,
    settings: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => {
    options = settings;
    const request = new EventEmitter() as EventEmitter & {
      end(): void;
      destroy(error: Error): void;
    };
    request.end = () =>
      queueMicrotask(() => {
        const response = Readable.from([body]) as IncomingMessage;
        response.statusCode = status;
        response.headers = { "content-type": type, ...headers };
        response.on("data", () => {});
        callback(response);
      });
    request.destroy = (error) => {
      request.emit("error", error);
    };
    return request;
  }) as typeof https.request);
  send.mockClear();
  return { send, options: () => options };
}
it("uses verified TLS, bounded socket pools and public DNS on the actual request", async () => {
  const fake = transport();
  const client = new OnlineHttp();
  try {
    expect(
      await client.get(
        "https://images-api.nasa.gov/search",
        new AbortController().signal,
      ),
    ).toEqual(Buffer.from("{}"));
    const options = fake.options();
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.headers).toMatchObject({
      accept: "application/json",
      "user-agent": expect.stringContaining("screensvr"),
    });
    const lookup = vi.spyOn(dns, "lookup").mockImplementation(((
      _host: string,
      _options: unknown,
      callback: (
        error: Error | null,
        values: { address: string; family: number }[],
      ) => void,
    ) =>
      callback(null, [
        { address: "127.0.0.1", family: 4 },
        { address: "8.8.8.8", family: 4 },
      ])) as typeof dns.lookup);
    const address = await new Promise((resolve, reject) => {
      options.lookup!("images-api.nasa.gov", {}, (error, address) =>
        error ? reject(error) : resolve(address),
      );
    });
    expect(lookup).toHaveBeenCalled();
    expect(address).toBe("8.8.8.8");
  } finally {
    client.close();
  }
});
it("never follows redirects and honors bounded Retry-After without exposing provider responses", async () => {
  const fake = transport({
    status: 302,
    headers: { location: "https://evil.example/secret", "retry-after": "120" },
    body: Buffer.from("SECRET"),
  });
  const client = new OnlineHttp();
  try {
    await expect(
      client.get(
        "https://images-api.nasa.gov/search",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      retryAfter: 120000,
      message: expect.not.stringContaining("SECRET"),
    });
    expect(fake.send).toHaveBeenCalledTimes(1);
  } finally {
    client.close();
  }
});
it("rejects oversized or wrongly typed responses and pre-aborted reads", async () => {
  const client = new OnlineHttp();
  try {
    transport({ type: "text/html" });
    await expect(
      client.get(
        "https://images-api.nasa.gov/search",
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(OnlineHttpError);
    transport({ headers: { "content-length": String(3 * 1024 * 1024) } });
    await expect(
      client.get(
        "https://images-api.nasa.gov/search",
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    transport({ body: Buffer.alloc(2 * 1024 * 1024 + 1) });
    await expect(
      client.get(
        "https://images-api.nasa.gov/search",
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    const fake = transport();
    await expect(
      client.get("https://images-api.nasa.gov/search", AbortSignal.abort()),
    ).rejects.toThrow();
    expect(fake.send).not.toHaveBeenCalled();
  } finally {
    client.close();
  }
});
