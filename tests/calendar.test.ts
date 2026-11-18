import { afterEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { manifestSchema } from "../src/shared/contracts.js";
import {
  bindingsSchema,
  datumSchema,
  type Bindings,
} from "../src/shared/face-data.js";
import { frameData } from "../web/src/face-data.js";
import { calendarDate, isCalendarValue } from "../src/shared/calendar.js";
import {
  parseFeed,
  type Occurrence,
} from "../src/server/integrations/ical-parser.js";
import {
  nextAppointment,
  homeAssistantEvents,
} from "../src/server/integrations/calendars.js";
import {
  feedUrl,
  calendarGet,
} from "../src/server/integrations/calendar-http.js";
import { createApp } from "../src/server/app.js";
import {
  administrator,
  temporaryDirectory,
  faceZip,
  upload,
} from "./helpers.js";
import {
  FakeCalendar,
  calendarFeed,
  calendarEvent,
  calendarTimestamp,
} from "./fake-calendar.js";
import { FakeHomeAssistant, fakeToken } from "./fake-home-assistant.js";
import calendarManifest from "../faces/builtin-calendar/manifest.json" with { type: "json" };

const now = Date.parse("2026-11-17T12:00:00Z");
const parse = (
  events: string[],
  timezone = "UTC",
  from = now - 86400000,
  to = now + 30 * 86400000,
) =>
  parseFeed(
    calendarFeed(...events),
    timezone,
    from,
    to,
    AbortSignal.timeout(10000),
  );
const timed = (
  start: number,
  end: number,
  title = "Appointment",
): Occurrence => ({
  kind: "timed",
  start,
  end,
  title,
  key: title,
  private: false,
});
const select = (events: Occurrence[], at = now, timezone = "UTC") =>
  nextAppointment(
    events.map((event) => ({ event, showTitle: true, source: "one" })),
    timezone,
    at,
  );

describe("calendar contracts and selection", () => {
  it("requires v5, preserves confirmed-empty data, and projects only public nested fields", () => {
    const face = manifestSchema.parse(calendarManifest);
    for (const schemaVersion of [1, 2, 3, 4])
      expect(
        manifestSchema.safeParse({ ...calendarManifest, schemaVersion })
          .success,
      ).toBe(false);
    const datum = {
      type: "calendar" as const,
      status: "ready" as const,
      unit: null,
      updatedAt: null,
      observedAt: now,
      expiresAt: now + 90000,
      value: { event: null, complete: true },
    };
    expect(datumSchema.safeParse(datum).success).toBe(true);
    expect(isCalendarValue({ event: null, complete: false })).toBe(true);
    const unsafe = {
      ...datum,
      value: {
        event: {
          ...timed(now, now + 60000),
          description: "DO NOT EXPOSE",
          sourceId: "calendar.private",
        },
        complete: true,
        secret: "NEVER",
      },
    };
    expect(JSON.stringify(frameData(face, { calendar: unsafe }))).not.toMatch(
      /DO NOT|NEVER|sourceId|private|key/,
    );
    for (const event of [
      {
        kind: "all-day",
        startDate: "2026-02-30",
        endDate: "2026-03-01",
        title: null,
      },
      { kind: "timed", start: 10, end: 9, title: null },
    ])
      expect(isCalendarValue({ event, complete: true })).toBe(false);
    expect(calendarDate("2024-02-29")).toBe(true);
  });
  it("defaults to busy-only and bounds and deduplicates source selections", () => {
    const source = {
      integrationId: "00000000-0000-4000-8000-000000000001",
      sourceId: "calendar.family",
    };
    expect(
      bindingsSchema.parse({ calendar: { calendars: [source] } }).calendar,
    ).toEqual({
      calendars: [{ ...source, showTitle: false }],
    });
    for (const calendars of [[], [source, source], Array(9).fill(source)])
      expect(
        bindingsSchema.safeParse({ calendar: { calendars } }).success,
      ).toBe(false);
  });
  it("keeps ongoing appointments, resolves ties, and prefers timed events on the earliest day", () => {
    const allDay: Occurrence = {
      kind: "all-day",
      startDate: "2026-11-17",
      endDate: "2026-11-18",
      title: "Birthday",
      key: "all",
      private: false,
    };
    const ongoing = timed(now - 60000, now + 60000, "Now");
    const future = timed(now + 120000, now + 180000, "Next");
    expect(select([allDay, future, ongoing])).toMatchObject({ title: "Now" });
    expect(select([allDay, future, ongoing], now + 60000)).toMatchObject({
      title: "Next",
    });
    expect(select([allDay, future], now + 180000)).toMatchObject({
      title: "Birthday",
    });
    expect(
      select([allDay, timed(now + 86400000, now + 86460000)]),
    ).toMatchObject({ kind: "all-day" });
    expect(select([allDay], Date.parse("2026-11-18T00:00Z"))).toBeNull();
    expect(
      select([timed(now + 31 * 86400000, now + 32 * 86400000)]),
    ).toBeNull();
    const privateEvent = { ...ongoing, private: true };
    expect(select([privateEvent])).toMatchObject({ title: null });
  });
  it("normalizes Home Assistant date and dateTime responses without raw metadata", () => {
    const events = homeAssistantEvents([
      {
        start: { date: "2026-11-17" },
        end: { date: "2026-11-19" },
        summary: "Holiday",
        description: "SECRET",
        location: "SECRET",
        uid: "SECRET",
      },
      {
        start: { dateTime: "2026-11-17T15:00:00+02:00" },
        end: { dateTime: "2026-11-17T16:00:00+02:00" },
        summary: "Meet",
      },
    ]);
    expect(events[1]).toMatchObject({ start: now + 3600000 });
    expect(JSON.stringify(events)).not.toContain("SECRET");
    expect(() =>
      homeAssistantEvents([
        {
          start: { dateTime: "2026-11-17T15:00:00" },
          end: { dateTime: "2026-11-17T16:00:00" },
        },
      ]),
    ).toThrow();
  });
  it("selects from a bounded large window without publishing an agenda and drops zero-duration events at their end", () => {
    function* candidates() {
      for (let index = 0; index < 50000; index++)
        yield {
          event: timed(now + 3600000 + index, now + 7200000 + index),
          source: "one",
          showTitle: true,
        };
      yield {
        event: timed(now + 1000, now + 2000, "Soon"),
        source: "two",
        showTitle: true,
      };
    }
    expect(nextAppointment(candidates(), "UTC", now)).toMatchObject({
      title: "Soon",
    });
    expect(select([timed(now, now)])).toBeNull();
  });
});

describe("bounded iCalendar parsing", () => {
  it("expands recurrence with precise exclusions, moved and cancelled occurrences and RDATE", async () => {
    const events = await parse([
      calendarEvent(
        `UID:series\nDTSTART:20261117T130000Z\nDTEND:20261117T140000Z\nRRULE:FREQ=DAILY;COUNT=5\nEXDATE:20261118T130000Z\nRDATE:20261124T130000Z\nSUMMARY:Meeting`,
      ),
      calendarEvent(
        `UID:series\nRECURRENCE-ID:20261119T130000Z\nDTSTART:20261119T150000Z\nDTEND:20261119T160000Z\nSUMMARY:Moved`,
      ),
      calendarEvent(
        `UID:series\nRECURRENCE-ID:20261120T130000Z\nDTSTART:20261120T130000Z\nDTEND:20261120T140000Z\nSTATUS:CANCELLED\nSUMMARY:Cancelled`,
      ),
    ]);
    expect(
      events.map(
        (event) =>
          event.kind === "timed" && new Date(event.start).toISOString(),
      ),
    ).toEqual([
      "2026-11-17T13:00:00.000Z",
      "2026-11-19T15:00:00.000Z",
      "2026-11-21T13:00:00.000Z",
      "2026-11-24T13:00:00.000Z",
    ]);
    expect(events[1].title).toBe("Moved");
  });
  it("preserves all-day and multi-day dates and uses the configured floating timezone", async () => {
    const events = await parse(
      [
        calendarEvent(
          "UID:all\nDTSTART;VALUE=DATE:20261117\nDTEND;VALUE=DATE:20261120\nSUMMARY:Away",
        ),
        calendarEvent(
          "UID:floating\nDTSTART:20261117T150000\nDTEND:20261117T160000\nSUMMARY:Floating",
        ),
      ],
      "Europe/Helsinki",
    );
    expect(events[0]).toMatchObject({
      kind: "all-day",
      startDate: "2026-11-17",
      endDate: "2026-11-20",
    });
    expect(events[1]).toMatchObject({
      kind: "timed",
      start: Date.parse("2026-11-17T13:00:00Z"),
    });
  });
  it("expands in the event timezone across DST rather than adding 24 hours", async () => {
    const events = await parse(
      [
        calendarEvent(
          "UID:dst\nDTSTART;TZID=America/New_York:20260307T090000\nDTEND;TZID=America/New_York:20260307T100000\nRRULE:FREQ=DAILY;COUNT=3\nSUMMARY:Morning",
        ),
      ],
      "UTC",
      Date.parse("2026-03-07T00:00Z"),
      Date.parse("2026-03-10T00:00Z"),
    );
    expect(
      events.map(
        (event) =>
          event.kind === "timed" && new Date(event.start).toISOString(),
      ),
    ).toEqual([
      "2026-03-07T14:00:00.000Z",
      "2026-03-08T13:00:00.000Z",
      "2026-03-09T13:00:00.000Z",
    ]);
  });
  it("handles Windows timezone identifiers and cancellation-only overrides", async () => {
    const events = await parse([
      calendarEvent(
        "UID:windows\nDTSTART;TZID=Eastern Standard Time:20261117T090000\nDTEND;TZID=Eastern Standard Time:20261117T100000\nSUMMARY:Windows time",
      ),
      calendarEvent(
        "UID:cancel-only\nDTSTART:20261117T150000Z\nDTEND:20261117T160000Z\nRRULE:FREQ=DAILY;COUNT=2\nSUMMARY:Series",
      ),
      calendarEvent(
        "UID:cancel-only\nRECURRENCE-ID:20261118T150000Z\nSTATUS:CANCELLED",
      ),
    ]);
    expect(events[0]).toMatchObject({
      kind: "timed",
      start: Date.parse("2026-11-17T14:00:00Z"),
    });
    expect(
      events.filter((event) => event.key.startsWith("cancel-only")),
    ).toHaveLength(1);
  });
  it("retains privacy classification, drops transparent events, and rejects unsupported/runaway feeds", async () => {
    const events = await parse([
      calendarEvent(
        "UID:private\nDTSTART:20261117T130000Z\nDTEND:20261117T140000Z\nCLASS:PRIVATE\nSUMMARY:Medical\nDESCRIPTION:SECRET\nLOCATION:SECRET",
      ),
      calendarEvent(
        "UID:free\nDTSTART:20261117T150000Z\nDTEND:20261117T160000Z\nTRANSP:TRANSPARENT\nSUMMARY:Free",
      ),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].private).toBe(true);
    expect(JSON.stringify(events)).not.toContain("SECRET");
    await expect(
      parseFeed(
        "<html>not a feed</html>",
        "UTC",
        now,
        now + 1000,
        AbortSignal.timeout(10000),
      ),
    ).rejects.toThrow("invalid");
    await expect(
      parse([
        calendarEvent(
          "UID:runaway\nDTSTART:20261117T120000Z\nDTEND:20261117T120001Z\nRRULE:FREQ=SECONDLY\nSUMMARY:Too much",
        ),
      ]),
    ).rejects.toThrow(/limit/);
    await expect(
      parse([
        calendarEvent(
          "UID:bad-zone\nDTSTART;TZID=Imaginary/Timezone:20261117T130000\nDTEND;TZID=Imaginary/Timezone:20261117T140000\nSUMMARY:Unknown timezone",
        ),
      ]),
    ).rejects.toThrow();
    await expect(
      parse([
        calendarEvent(
          "UID:bad-date\nDTSTART:20260230T130000Z\nDTEND:20260301T140000Z\nSUMMARY:Invalid date",
        ),
      ]),
    ).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      parseFeed(calendarFeed(), "UTC", now, now + 1000, controller.signal),
    ).rejects.toThrow("cancelled");
  });
});

let server: Awaited<ReturnType<typeof createApp>> | undefined;
let feed: FakeCalendar | undefined;
let ha: FakeHomeAssistant | undefined;
let directory: string | undefined;
afterEach(async () => {
  await server?.app.close();
  await feed?.close();
  await ha?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  server = undefined;
  feed = undefined;
  ha = undefined;
  directory = undefined;
  vi.restoreAllMocks();
});

describe("calendar APIs and privacy boundary", () => {
  async function setup() {
    feed = await FakeCalendar.start();
    const at = Date.now() + 2 * 3600000;
    feed.body = calendarFeed(
      calendarEvent(
        `UID:private-id\nDTSTART:${calendarTimestamp(at)}\nDTEND:${calendarTimestamp(at + 3600000)}\nSUMMARY:Family visit\nDESCRIPTION:SECRET DESCRIPTION\nLOCATION:SECRET LOCATION`,
      ),
    );
    directory = await temporaryDirectory("calendar-");
    server = await createApp({ dataDir: directory });
    const headers = await administrator(server.app);
    const create = await server.app.inject({
      method: "POST",
      url: "/api/integrations",
      headers,
      payload: {
        type: "ical",
        name: "Family calendar",
        feedUrl: feed.url,
        timezone: "UTC",
      },
    });
    expect(create.statusCode).toBe(201);
    const integrationId = create.json().id as string;
    const display = (
      await server.app.inject({
        method: "POST",
        url: "/api/devices",
        headers,
        payload: {
          name: "Calendar room",
          timezone: "UTC",
          faceId: "builtin-calendar",
        },
      })
    ).json();
    const binding = {
      calendar: {
        calendars: [{ integrationId, sourceId: "calendar", showTitle: false }],
      },
    };
    const save = async (bindings: Bindings = binding) => {
      const device = server!.store.device(display.id)!;
      const response = await server!.app.inject({
        method: "PATCH",
        url: `/api/devices/${display.id}`,
        headers,
        payload: { revision: device.revision, bindings },
      });
      expect(response.statusCode).toBe(200);
    };
    const state = () => server!.states.state(display.id)!;
    return { headers, create, integrationId, display, binding, save, state };
  }
  it("encrypts feed URLs, selects no sources implicitly, and publishes only opt-in titles", async () => {
    const { headers, create, integrationId, display, binding, save, state } =
      await setup();
    expect(create.body).not.toMatch(/private-feed-token|feed-secret|feedUrl/);
    expect(server!.store.integration(integrationId)!.base_url).toBe("UTC");
    expect(server!.store.integration(integrationId)!.credentials).not.toContain(
      "feed-secret",
    );
    expect(feed!.requests).toHaveLength(0);
    expect(state().data.calendar.status).toBe("unbound");
    const discovery = await server!.app.inject({
      url: `/api/integrations/${integrationId}/sources?type=calendar`,
      headers,
    });
    expect(discovery.json().sources).toHaveLength(1);
    expect(feed!.requests).toHaveLength(0);
    await save();
    await expect.poll(() => state().data.calendar.status).toBe("ready");
    const publicState = await server!.app.inject(
      `/api${display.displayUrl}/state`,
    );
    expect(publicState.body).not.toMatch(
      /Family visit|private-id|DESCRIPTION|LOCATION|feed-secret|integrationId|sourceId/,
    );
    expect(publicState.json().data.calendar.value.event.title).toBeNull();
    binding.calendar.calendars[0].showTitle = true;
    await save();
    expect(state().data.calendar.value).toMatchObject({
      event: { title: "Family visit" },
    });
    expect(feed!.requests).toHaveLength(1);
    binding.calendar.calendars[0].showTitle = false;
    await save();
    expect(JSON.stringify(state())).not.toContain("Family visit");
    const edit = await server!.app.inject({
      method: "PATCH",
      url: `/api/integrations/${integrationId}`,
      headers,
      payload: { revision: 1, name: "Renamed" },
    });
    expect(edit.statusCode).toBe(200);
    expect(
      server!.integrations.secrets.decrypt(
        server!.store.integration(integrationId)!.credentials,
      ),
    ).toBe(feed!.url);
  });
  it("merges Home Assistant and feeds, isolates previews, and never reads unselected calendars", async () => {
    const { headers, display, binding, state } = await setup();
    ha = await FakeHomeAssistant.start();
    ha.calendars.set("calendar.work", [
      {
        start: { dateTime: new Date(Date.now() + 3600000).toISOString() },
        end: { dateTime: new Date(Date.now() + 5400000).toISOString() },
        summary: "Team meeting",
        description: "UPSTREAM SECRET",
        location: "SECRET",
      },
    ]);
    ha.calendars.set("calendar.private", []);
    const connection = await server!.app.inject({
      method: "POST",
      url: "/api/integrations",
      headers,
      payload: {
        type: "home-assistant",
        name: "Home",
        baseUrl: ha.url,
        token: fakeToken,
      },
    });
    const integrationId = connection.json().id;
    binding.calendar.calendars.push({
      integrationId,
      sourceId: "calendar.work",
      showTitle: true,
    });
    const preview = await server!.app.inject({
      method: "POST",
      url: `/api/devices/${display.id}/preview`,
      headers,
      payload: { faceId: "builtin-calendar", bindings: binding },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.calendar.value.event.title).toBe("Team meeting");
    expect(preview.body).not.toMatch(
      /UPSTREAM SECRET|LOCATION|calendar.work|integrationId/,
    );
    expect(state().data.calendar.status).toBe("unbound");
    expect(
      ha.calendarRequests.every((request) => request.startsWith("GET ")),
    ).toBe(true);
    expect(
      ha.calendarRequests.some((request) =>
        request.includes("/api/calendars/calendar.private"),
      ),
    ).toBe(false);
    expect(
      ha.commands.some((command) => command.type.includes("service")),
    ).toBe(false);
  });
  it("protects inactive scene references, restores selections, and persists privacy choices", async () => {
    const { headers, integrationId, display, binding, save, state } =
      await setup();
    await save();
    await expect.poll(() => state().data.calendar.status).toBe("ready");
    const sceneId = server!.store.selection(display.id)!.sceneId;
    const copy = await server!.app.inject({
      method: "POST",
      url: `/api/devices/${display.id}/scenes`,
      headers,
      payload: {
        revision: server!.store.device(display.id)!.revision,
        name: "Another calendar",
        copyFrom: sceneId,
      },
    });
    expect(copy.statusCode).toBe(201);
    await save({});
    const remove = await server!.app.inject({
      method: "DELETE",
      url: `/api/integrations/${integrationId}`,
      headers,
    });
    expect(remove.statusCode).toBe(409);
    await server!.app.close();
    server = await createApp({ dataDir: directory! });
    expect(
      server.store.scene(display.id, copy.json().createdSceneId)?.bindings,
    ).toEqual(binding);
    expect(server.store.bindings(display.id)).toEqual({});
    expect(server.store.db.prepare("PRAGMA user_version").get()).toMatchObject({
      user_version: 5,
    });
  });
  it("supports calendar and sensor inputs from the same Home Assistant connection in either binding order", async () => {
    const { headers, display } = await setup();
    ha = await FakeHomeAssistant.start();
    ha.calendars.set("calendar.work", []);
    const response = await server!.app.inject({
      method: "POST",
      url: "/api/integrations",
      headers,
      payload: {
        type: "home-assistant",
        name: "Mixed inputs",
        baseUrl: ha.url,
        token: fakeToken,
      },
    });
    const integrationId = response.json().id;
    await expect
      .poll(
        () =>
          server!.integrations.list().find((item) => item.id === integrationId)
            ?.status,
      )
      .toBe("connected");
    const face = {
      ...calendarManifest,
      id: "mixed-calendar",
      inputs: [
        ...calendarManifest.inputs,
        {
          key: "roomTemperature",
          label: "Room temperature",
          type: "number",
          quantity: "temperature",
        },
      ],
    };
    expect((await upload(server!.app, headers, faceZip(face))).statusCode).toBe(
      201,
    );
    const calendar = {
      calendars: [
        { integrationId, sourceId: "calendar.work", showTitle: false },
      ],
    };
    const roomTemperature = {
      integrationId,
      sourceId: "sensor.living_room_temperature",
    };
    for (const bindings of [
      { calendar, roomTemperature },
      { roomTemperature, calendar },
    ]) {
      const preview = await server!.app.inject({
        method: "POST",
        url: `/api/devices/${display.id}/preview`,
        headers,
        payload: { faceId: face.id, bindings },
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().data.roomTemperature).toMatchObject({
        status: "ready",
        value: 21.3,
      });
      expect(preview.json().data.calendar).toMatchObject({
        status: "ready",
        value: { event: null, complete: true },
      });
    }
  });
  it("requires admin access, rejects redirects, and blocks unsafe feed destinations", async () => {
    const { headers, integrationId } = await setup();
    expect(
      (
        await server!.app.inject(
          `/api/integrations/${integrationId}/sources?type=calendar`,
        )
      ).statusCode,
    ).toBe(401);
    expect(() => feedUrl("http://169.254.169.254/latest/meta-data")).toThrow();
    expect(() =>
      feedUrl("https://user:pass@example.com/calendar.ics"),
    ).toThrow();
    expect(feedUrl("webcal://example.com/cal.ics?token=secret")).toBe(
      "https://example.com/cal.ics?token=secret",
    );
    const redirect = new URL("/redirect", feed!.url).href;
    await expect(
      calendarGet(redirect, AbortSignal.timeout(10000)),
    ).rejects.toThrow();
    expect(feed!.requests).toHaveLength(1);
    const bad = await server!.app.inject({
      method: "PATCH",
      url: `/api/integrations/${integrationId}`,
      headers,
      payload: { revision: 1, baseUrl: "http://elsewhere" },
    });
    expect(bad.statusCode).toBe(400);
  });
  it("tests a saved secret without returning it and retries when the editor resends its unchanged timezone", async () => {
    const { headers, integrationId } = await setup();
    const retry = vi.spyOn(server!.integrations.calendars, "retry");
    const result = await server!.app.inject({
      method: "POST",
      url: `/api/integrations/${integrationId}/test`,
      headers,
      payload: { timezone: "UTC" },
    });
    expect(result.statusCode).toBe(200);
    expect(retry).toHaveBeenCalledWith(integrationId);
    expect(result.body).not.toMatch(/feed-secret|private-feed-token/);
  });
  it("bounds HTTP bodies, supports conditional reads, and cancels stalled requests without exposing upstream secrets", async () => {
    await setup();
    const first = await calendarGet(feed!.url, AbortSignal.timeout(10000));
    const second = await calendarGet(feed!.url, AbortSignal.timeout(10000), {
      "if-none-match": first.etag!,
    });
    expect(second).toMatchObject({ status: 304, body: "" });
    feed!.body = "x".repeat(5 * 1024 * 1024 + 1);
    await expect(
      calendarGet(feed!.url, AbortSignal.timeout(10000)),
    ).rejects.toThrow();
    feed!.status = 403;
    await expect(
      calendarGet(feed!.url, AbortSignal.timeout(10000)),
    ).rejects.not.toThrow(/UPSTREAM PRIVATE|feed-secret|private-feed-token/);
    feed!.hold = true;
    await expect(
      calendarGet(feed!.url, AbortSignal.timeout(20)),
    ).rejects.toThrow("Cannot read calendar");
  });
});
