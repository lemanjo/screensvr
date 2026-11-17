import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { allowedAddress, secureLookup } from "./network.js";
import { ConnectorError } from "./connector.js";
import { UserError } from "../faces.js";

export const CALENDAR_BODY_LIMIT = 5 * 1024 * 1024;
export function feedUrl(value: string) {
  try {
    const url = new URL(value.replace(/^webcal:/i, "https:"));
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error();
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !allowedAddress(host)) throw new Error();
    return url.href;
  } catch {
    // Never include even a portion of a bearer subscription URL.
    throw new UserError(
      "Enter a direct HTTP(S) calendar feed URL without embedded credentials, fragment, or a blocked address.",
    );
  }
}
export const calendarTimezone = (value: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return value;
  } catch {
    throw new UserError("Choose a valid calendar timezone.");
  }
};
export class CalendarHttpError extends ConnectorError {
  constructor(readonly status: number) {
    super(
      status === 401
        ? "Calendar credentials were rejected."
        : status === 403
          ? "Calendar access was refused."
          : "Calendar read failed. Check its access, direct URL, and API compatibility.",
      status === 401,
    );
  }
}
export function calendarGet(
  address: string,
  signal: AbortSignal,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; etag?: string; modified?: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(feedUrl(address));
    const send = url.protocol === "https:" ? https.request : http.request;
    const request = send(
      url,
      {
        method: "GET",
        agent: false,
        lookup: secureLookup,
        rejectUnauthorized: true,
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        headers: {
          accept: "text/calendar,application/json",
          "accept-encoding": "identity",
          ...headers,
        },
      },
      (response) => {
        const status = response.statusCode ?? 502;
        if (status !== 200 && status !== 304) {
          response.destroy();
          reject(new CalendarHttpError(status));
          return;
        }
        if (
          response.headers["content-encoding"] &&
          response.headers["content-encoding"] !== "identity"
        ) {
          response.destroy();
          reject(
            new ConnectorError(
              "Compressed calendar responses are not supported.",
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > CALENDAR_BODY_LIMIT) {
            request.destroy(
              new ConnectorError("Calendar response exceeds the 5 MiB limit."),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", () =>
          reject(new ConnectorError("Calendar response was interrupted.")),
        );
        response.once("end", () => {
          const safe = (value?: string) =>
            value && value.length <= 1024 && !/[\r\n]/.test(value)
              ? value
              : undefined;
          resolve({
            status,
            body: Buffer.concat(chunks).toString("utf8"),
            etag: safe(response.headers.etag),
            modified: safe(response.headers["last-modified"]),
          });
        });
      },
    );
    request.once("error", (error) =>
      reject(
        error instanceof ConnectorError
          ? error
          : new ConnectorError(
              "Cannot read calendar. Check its network, TLS certificate, and response timeout.",
            ),
      ),
    );
    request.end();
  });
}
