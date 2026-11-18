import https from "node:https";
import dns from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { allowedAddress } from "./network.js";
import { ConnectorError } from "./connector.js";

const hosts = new Set([
  "commons.wikimedia.org",
  "upload.wikimedia.org",
  "thumb.wikimedia.org",
  "images-api.nasa.gov",
  "images-assets.nasa.gov",
]);
const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
] as const)
  privateAddresses.addSubnet(address, prefix, "ipv4");
privateAddresses.addAddress("::1", "ipv6");
privateAddresses.addSubnet("fc00::", 7, "ipv6");
privateAddresses.addSubnet("2001:db8::", 32, "ipv6");
privateAddresses.addSubnet("64:ff9b::", 96, "ipv6");
privateAddresses.addSubnet("64:ff9b:1::", 48, "ipv6");
privateAddresses.addSubnet("2001::", 32, "ipv6");
privateAddresses.addSubnet("2002::", 16, "ipv6");
const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");

export function publicAddress(address: string) {
  return (
    allowedAddress(address) &&
    (isIP(address) === 4 || globalIpv6.check(address, "ipv6")) &&
    !privateAddresses.check(address, "ipv4") &&
    !privateAddresses.check(address, "ipv6")
  );
}
export function onlineUrl(value: string, allowedHosts = hosts): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !allowedHosts.has(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new ConnectorError("Online background URL is not allowed.");
  return url.href;
}
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(
    hostname,
    { family: options.family, all: true },
    (error, addresses) => {
      if (error) return callback(error, "", 0);
      const allowed = addresses.filter((item) => publicAddress(item.address));
      if (!allowed.length)
        return callback(new Error("Public image address required."), "", 0);
      if (options.all) callback(null, allowed);
      else callback(null, allowed[0].address, allowed[0].family);
    },
  );
};

export class OnlineHttpError extends ConnectorError {
  constructor(readonly retryAfter = 60000) {
    super("Online image service is temporarily unavailable. Try again later.");
  }
}

/** Fixed public HTTPS origins, socket-time DNS validation, no redirects. */
export class OnlineHttp {
  private agent = new https.Agent({
    keepAlive: true,
    maxSockets: 2,
    // Leave room for all fixed origins: idle sockets on one origin must not
    // starve a request to another origin in Node's per-host agent queues.
    maxTotalSockets: 8,
    maxFreeSockets: 1,
  });
  private active = 0;
  async get(
    address: string,
    signal: AbortSignal,
    kind: "json" | "image" = "json",
  ): Promise<Buffer> {
    const url = onlineUrl(address);
    if (signal.aborted || this.active >= 16) throw new OnlineHttpError();
    this.active++;
    const limit = kind === "json" ? 2 * 1024 * 1024 : 20 * 1024 * 1024;
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        const request = https.request(
          url,
          {
            agent: this.agent,
            lookup: publicLookup,
            rejectUnauthorized: true,
            signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
            headers: {
              "user-agent":
                "screensvr/1.0 (https://github.com/lemanjo/screensvr)",
              accept:
                kind === "json"
                  ? "application/json"
                  : "image/jpeg,image/png,image/webp",
            },
          },
          (response) => {
            const contentType = response.headers["content-type"] ?? "";
            if (
              response.statusCode !== 200 ||
              !(kind === "json"
                ? /^application\/json\b/i.test(contentType)
                : /^image\/(?:jpeg|png|webp)\b/i.test(contentType)) ||
              Number(response.headers["content-length"] ?? 0) > limit
            ) {
              const header = response.headers["retry-after"];
              const seconds = typeof header === "string" ? Number(header) : NaN;
              const date =
                typeof header === "string" ? Date.parse(header) : NaN;
              const delay = Number.isFinite(seconds)
                ? seconds * 1000
                : date - Date.now();
              response.destroy();
              reject(
                new OnlineHttpError(
                  Number.isFinite(delay)
                    ? Math.max(60000, Math.min(86400000, delay))
                    : 60000,
                ),
              );
              return;
            }
            let size = 0;
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > limit) {
                request.destroy(new OnlineHttpError());
                return;
              }
              chunks.push(chunk);
            });
            response.once("end", () => resolve(Buffer.concat(chunks)));
            response.once("error", reject);
          },
        );
        request.once("error", reject);
        request.end();
      });
    } catch (error) {
      throw error instanceof OnlineHttpError ? error : new OnlineHttpError();
    } finally {
      this.active--;
    }
  }
  close() {
    this.agent.destroy();
  }
}
