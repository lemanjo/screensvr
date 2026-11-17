import { lookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { UserError } from "../faces.js";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["169.254.0.0", 16],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
blocked.addAddress("100.100.100.200", "ipv4");
blocked.addAddress("::", "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");
blocked.addSubnet("ff00::", 8, "ipv6");

export function allowedAddress(address: string) {
  const family = isIP(address);
  return (
    family !== 0 &&
    !blocked.check(address, family === 4 ? "ipv4" : "ipv6") &&
    // Node's BlockList also recognizes IPv4-mapped IPv6 addresses.
    !(family === 6 && blocked.check(address, "ipv4"))
  );
}

export function baseUrl(value: string) {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !allowedAddress(host)) throw new Error();
    return url.href.replace(/\/+$/, "");
  } catch {
    throw new UserError(
      "Enter an HTTP(S) Home Assistant base URL without credentials, query, fragment, or a link-local/metadata address.",
    );
  }
}

export function websocketUrl(value: string) {
  const url = new URL(`${baseUrl(value)}/api/websocket`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

// Check the actual DNS answer used by the socket, not a separate preflight
// resolution that could be replaced between validation and connection.
export const secureLookup: LookupFunction = (hostname, options, callback) => {
  lookup(
    hostname,
    { family: options.family, all: true },
    (error, addresses) => {
      if (error) return callback(error, "", 0);
      const allowed = addresses.filter((item) => allowedAddress(item.address));
      if (!allowed.length)
        return callback(
          new Error("The configured address is not allowed."),
          "",
          0,
        );
      if (options.all) callback(null, allowed);
      else callback(null, allowed[0].address, allowed[0].family);
    },
  );
};
