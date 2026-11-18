import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";

export const calendarFeed = (...events: string[]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//screensvr tests//EN",
    ...events,
    "END:VCALENDAR",
    "",
  ].join("\r\n");
export const calendarEvent = (lines: string) =>
  `BEGIN:VEVENT\r\n${lines.replace(/\r?\n/g, "\r\n")}\r\nEND:VEVENT`;
export const calendarTimestamp = (at: number) =>
  new Date(at)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

export class FakeCalendar {
  body = calendarFeed();
  status = 200;
  etag = '"one"';
  readonly requests: { method?: string; url?: string; etag?: string }[] = [];
  private held: ServerResponse[] = [];
  hold = false;
  private server = createServer((request, response) => {
    this.requests.push({
      method: request.method,
      url: request.url,
      etag: request.headers["if-none-match"],
    });
    if (request.url === "/redirect") {
      response
        .writeHead(302, { location: "/private/redirect-target.ics" })
        .end();
      return;
    }
    if (this.hold) {
      this.held.push(response);
      return;
    }
    this.respond(response, request.headers["if-none-match"]);
  });
  url = "";
  static async start() {
    const fake = new FakeCalendar();
    fake.server.listen(0, "127.0.0.1");
    await once(fake.server, "listening");
    const address = fake.server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing calendar fixture address.");
    fake.url = `http://127.0.0.1:${address.port}/private-feed-token/calendar.ics?key=feed-secret`;
    return fake;
  }
  private respond(response: ServerResponse, etag?: string) {
    if (this.status !== 200) {
      response.writeHead(this.status).end("UPSTREAM PRIVATE ERROR");
      return;
    }
    response.setHeader("etag", this.etag);
    response.setHeader("content-type", "text/calendar");
    response
      .writeHead(etag === this.etag ? 304 : 200)
      .end(etag === this.etag ? undefined : this.body);
  }
  release() {
    this.hold = false;
    for (const response of this.held) this.respond(response);
    this.held = [];
  }
  async close() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
