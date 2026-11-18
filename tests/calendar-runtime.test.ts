import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/db.js";
import {
  Calendars,
  CALENDAR_REFRESH,
  CALENDAR_MAX_AGE,
} from "../src/server/integrations/calendars.js";
import {
  calendarGet,
  CalendarHttpError,
} from "../src/server/integrations/calendar-http.js";
import {
  parseFeed,
  type Occurrence,
} from "../src/server/integrations/ical-parser.js";
import type { CalendarBinding } from "../src/shared/face-data.js";
import manifest from "../faces/builtin-calendar/manifest.json" with { type: "json" };

vi.mock("../src/server/integrations/calendar-http.js", async (original) => ({
  ...(await original<
    typeof import("../src/server/integrations/calendar-http.js")
  >()),
  calendarGet: vi.fn(),
}));
vi.mock("../src/server/integrations/ical-parser.js", () => ({
  parseFeed: vi.fn(),
}));

const now = Date.parse("2026-11-17T12:00Z");
const response = { status: 200, body: "feed", etag: '"v1"' };
let store: Store;
let calendars: Calendars;
let id: string;
let binding: CalendarBinding;
const changed = vi.fn();
const events: Occurrence[] = [
  {
    kind: "timed",
    start: now + 1000,
    end: now + 2000,
    key: "one",
    private: false,
    title: "Appointment",
  },
  {
    kind: "timed",
    start: now + 3 * 3600000,
    end: now + 4 * 3600000,
    key: "two",
    private: false,
    title: "Later",
  },
];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.mocked(calendarGet).mockReset().mockResolvedValue(response);
  vi.mocked(parseFeed).mockReset().mockResolvedValue(events);
  changed.mockClear();
  store = new Store(":memory:");
  store.db
    .prepare("INSERT INTO faces VALUES (?, ?, 1)")
    .run(manifest.id, JSON.stringify(manifest));
  store.createDevice("room", "room", "Room", manifest.id, {}, "UTC");
  id = randomUUID();
  store.db
    .prepare(
      "INSERT INTO integrations (id, type, name, base_url, credentials) VALUES (?, 'ical', 'Feed', 'UTC', 'https://example.test/feed.ics')",
    )
    .run(id);
  binding = {
    calendars: [{ integrationId: id, sourceId: "calendar", showTitle: false }],
  };
  store.replaceBindings("room", { calendar: binding });
  calendars = new Calendars(store, (value) => value, changed);
});
afterEach(() => {
  calendars.close();
  store.db.close();
  vi.useRealTimers();
});
const flush = () => vi.advanceTimersByTimeAsync(0);
const data = () => calendars.data(binding, "UTC");

describe("shared calendar lifecycle", () => {
  it("shares live/preview reads, advances at boundaries, and drops the last consumer", async () => {
    calendars.reconcile();
    await flush();
    expect(data()).toMatchObject({
      status: "ready",
      value: { event: { title: null } },
    });
    const close = await calendars.preview([binding]);
    expect(calendarGet).toHaveBeenCalledOnce();
    close();
    changed.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(changed).toHaveBeenCalledWith(id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(data().value).toMatchObject({
      event: { start: events[1].kind === "timed" ? events[1].start : 0 },
    });
    store.replaceBindings("room", {});
    calendars.reconcile();
    expect(vi.getTimerCount()).toBe(0);
    expect(data().status).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(CALENDAR_REFRESH * 2);
    expect(calendarGet).toHaveBeenCalledOnce();
  });
  it("retains stale failures, never renews confirmation age with heartbeats, and recovers to confirmed empty", async () => {
    calendars.reconcile();
    await flush();
    vi.mocked(calendarGet).mockRejectedValue(new Error("Network"));
    await vi.advanceTimersByTimeAsync(CALENDAR_REFRESH);
    expect(data()).toMatchObject({
      status: "stale",
      observedAt: now,
      value: { complete: false },
    });
    await vi.advanceTimersByTimeAsync(CALENDAR_MAX_AGE);
    expect(data().expiresAt).toBe(now + CALENDAR_MAX_AGE);
    vi.mocked(calendarGet).mockResolvedValue(response);
    vi.mocked(parseFeed).mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(CALENDAR_REFRESH);
    expect(data()).toMatchObject({
      status: "ready",
      value: { event: null, complete: true },
    });
  });
  it("uses conditional requests but re-expands cached feed text on a valid 304", async () => {
    calendars.reconcile();
    await flush();
    vi.mocked(calendarGet).mockResolvedValue({ status: 304, body: "" });
    await vi.advanceTimersByTimeAsync(CALENDAR_REFRESH);
    expect(calendarGet).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(AbortSignal),
      {
        "if-none-match": '"v1"',
      },
    );
    expect(parseFeed).toHaveBeenLastCalledWith(
      "feed",
      "UTC",
      expect.any(Number),
      expect.any(Number),
      expect.any(AbortSignal),
    );
    expect(data().observedAt).toBe(now + CALENDAR_REFRESH);
  });
  it("clears revoked access, stops authentication retries, and retries only on an explicit request", async () => {
    calendars.reconcile();
    await flush();
    vi.mocked(calendarGet).mockRejectedValue(new CalendarHttpError(401));
    await vi.advanceTimersByTimeAsync(CALENDAR_REFRESH);
    expect(data()).toMatchObject({ status: "unavailable", value: null });
    expect(calendars.health(id)?.status).toBe("authentication-error");
    const calls = vi.mocked(calendarGet).mock.calls.length;
    await vi.advanceTimersByTimeAsync(CALENDAR_REFRESH * 4);
    expect(calendarGet).toHaveBeenCalledTimes(calls);
    vi.mocked(calendarGet).mockResolvedValue(response);
    calendars.retry(id);
    await flush();
    expect(data().status).toBe("ready");
  });
  it("marks merged results incomplete when one source fails, rather than claiming an empty calendar", async () => {
    const second = randomUUID();
    store.db
      .prepare(
        "INSERT INTO integrations (id, type, name, base_url, credentials) VALUES (?, 'ical', 'Other', 'UTC', 'https://example.test/other.ics')",
      )
      .run(second);
    binding.calendars.push({
      integrationId: second,
      sourceId: "calendar",
      showTitle: false,
    });
    store.replaceBindings("room", { calendar: binding });
    vi.mocked(calendarGet).mockImplementation(async (url) => {
      if (url.includes("other")) throw new Error("Unavailable");
      return response;
    });
    vi.mocked(parseFeed).mockResolvedValue([]);
    calendars.reconcile();
    await flush();
    expect(data()).toMatchObject({
      status: "stale",
      value: { event: null, complete: false },
    });
  });
  it("ignores replaced in-flight reads and never restores a removed source", async () => {
    let resolve!: (value: typeof response) => void;
    vi.mocked(calendarGet).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    calendars.reconcile();
    await flush();
    store.replaceBindings("room", {});
    calendars.reconcile();
    resolve(response);
    await flush();
    expect(data().status).toBe("unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("marks backward clock jumps stale and refreshes the occurrence window promptly", async () => {
    calendars.reconcile();
    await flush();
    vi.setSystemTime(now - 5 * 86400000);
    expect(data()).toMatchObject({
      status: "stale",
      value: { complete: false },
    });
    await vi.advanceTimersByTimeAsync(30000);
    expect(calendarGet).toHaveBeenCalledTimes(2);
    expect(data().status).toBe("ready");
    expect(data().observedAt).toBeGreaterThan(now - 5 * 86400000);
    expect(data().observedAt).toBeLessThanOrEqual(now - 5 * 86400000 + 30000);
  });
  it("bounds concurrent calendar reads to four and cancels queued unused sources", async () => {
    store.db
      .prepare(
        "UPDATE integrations SET type = 'home-assistant', base_url = 'https://example.test', credentials = 'token' WHERE id = ?",
      )
      .run(id);
    binding.calendars = Array.from({ length: 8 }, (_, index) => ({
      integrationId: id,
      sourceId: `calendar.test_${index}`,
      showTitle: false,
    }));
    store.replaceBindings("room", { calendar: binding });
    const pending: (() => void)[] = [];
    vi.mocked(calendarGet).mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve({ status: 200, body: "[]" }));
        }),
    );
    calendars.reconcile();
    expect(calendarGet).toHaveBeenCalledTimes(4);
    store.replaceBindings("room", {});
    calendars.reconcile();
    pending.forEach((resolve) => resolve());
    await flush();
    expect(calendarGet).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
});
