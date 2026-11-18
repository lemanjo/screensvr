import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  bindingSources,
  isCalendarBinding,
  emptyDatum,
  type CalendarBinding,
  type Datum,
  type Source,
  type SourceBinding,
} from "../../shared/face-data.js";
import {
  calendarDate,
  projectCalendar,
  type CalendarEvent,
} from "../../shared/calendar.js";
import type { IntegrationRow, Store } from "../db.js";
import { baseUrl } from "./network.js";
import { calendarGet, CalendarHttpError } from "./calendar-http.js";
import { parseFeed, type Occurrence } from "./ical-parser.js";
import { ConnectorError } from "./connector.js";

export const CALENDAR_REFRESH = 5 * 60000;
export const CALENDAR_MAX_AGE = 15 * 60000;
const DAY = 86400000;
const sourceKey = (source: SourceBinding) =>
  `${source.integrationId}:${source.sourceId}`;
export const calendarSource = (id: string, label: string): Source => ({
  id,
  label,
  type: "calendar",
  unit: null,
  available: true,
});
type Entry = {
  source: SourceBinding;
  revision: number;
  consumers: Set<symbol>;
  abort: AbortController;
  events?: Occurrence[];
  at?: number;
  failed: boolean;
  stopped: boolean;
  busy: boolean;
  attemptedAt?: number;
  ready: Promise<void>;
  settle: () => void;
  timer?: ReturnType<typeof setTimeout>;
  text?: string;
  etag?: string;
  modified?: string;
};
const eventSchema = z.object({
  start: z.object({
    date: z.string().optional(),
    dateTime: z.string().optional(),
  }),
  end: z.object({
    date: z.string().optional(),
    dateTime: z.string().optional(),
  }),
  summary: z.string().max(10000).optional(),
});
export function homeAssistantEvents(value: unknown): Occurrence[] {
  const rows = z.array(eventSchema).max(10000).parse(value);
  return rows.map((row) => {
    const common = {
      key: createHash("sha256").update(JSON.stringify(row)).digest("hex"),
      private: false,
      title: row.summary?.replace(/\p{Cc}/gu, " ").slice(0, 200) ?? null,
    };
    if (row.start.date !== undefined && row.end.date !== undefined) {
      if (
        !calendarDate(row.start.date) ||
        !calendarDate(row.end.date) ||
        row.end.date <= row.start.date
      )
        throw new ConnectorError("Invalid all-day calendar event.");
      return {
        ...common,
        kind: "all-day",
        startDate: row.start.date,
        endDate: row.end.date,
      };
    }
    const instant = (text?: string) => {
      if (!text || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) throw new Error();
      return Temporal.Instant.from(text).epochMilliseconds;
    };
    const start = instant(row.start.dateTime),
      end = instant(row.end.dateTime);
    if (start < 0 || end < start)
      throw new Error("Invalid timed calendar event.");
    return { ...common, kind: "timed", start, end };
  });
}

type Candidate = { event: Occurrence; showTitle: boolean; source: string };
export function nextAppointment(
  candidates: Iterable<Candidate>,
  timezone: string,
  now: number,
): CalendarEvent | null {
  const instant = Temporal.Instant.fromEpochMilliseconds(now);
  const today = instant.toZonedDateTimeISO(timezone).toPlainDate().toString();
  const lastDay = Temporal.PlainDate.from(today).add({ days: 30 }).toString();
  const horizon = instant
    .toZonedDateTimeISO(timezone)
    .add({ days: 30 }).epochMilliseconds;
  let timed:
    (Candidate & { event: Extract<Occurrence, { kind: "timed" }> }) | undefined;
  let allDay:
    | (Candidate & {
        event: Extract<Occurrence, { kind: "all-day" }>;
        day: string;
      })
    | undefined;
  const tie = (a: Candidate, b: Candidate) =>
    a.source.localeCompare(b.source) || a.event.key.localeCompare(b.event.key);
  // A single pass, with no full-window sort or per-event timezone conversion.
  // This keeps public state reads inexpensive even at the occurrence limit.
  for (const candidate of candidates) {
    const event = candidate.event;
    if (event.kind === "all-day") {
      if (event.endDate <= today || event.startDate > lastDay) continue;
      const day = event.startDate < today ? today : event.startDate;
      if (
        !allDay ||
        day < allDay.day ||
        (day === allDay.day &&
          (event.startDate < allDay.event.startDate ||
            (event.startDate === allDay.event.startDate &&
              tie(candidate, allDay) < 0)))
      )
        allDay = { ...candidate, event, day };
    } else {
      if (event.end <= now || event.start > horizon) continue;
      if (
        !timed ||
        event.start < timed.event.start ||
        (event.start === timed.event.start && tie(candidate, timed) < 0)
      )
        timed = { ...candidate, event };
    }
  }
  const timedDay =
    timed &&
    Temporal.Instant.fromEpochMilliseconds(Math.max(timed.event.start, now))
      .toZonedDateTimeISO(timezone)
      .toPlainDate()
      .toString();
  const selected =
    allDay && (!timedDay || allDay.day < timedDay) ? allDay : timed;
  if (!selected) return null;
  return projectCalendar({
    event: {
      ...selected.event,
      title:
        selected.showTitle && !selected.event.private
          ? selected.event.title
          : null,
    },
    complete: true,
  }).event;
}

// Provider occurrence windows stay private. Only data() creates a public datum,
// after selection and per-scene/per-source title redaction.
export class Calendars {
  private entries = new Map<string, Entry>();
  private live = new Map<string, { revision: number; close: () => void }>();
  private queue: Entry[] = [];
  private running = 0;
  private closed = false;
  private boundary?: ReturnType<typeof setTimeout>;
  private tests = 0;
  private operations = new Set<AbortController>();
  private discoveries = new Map<
    string,
    {
      revision: number;
      at: number;
      pending: Promise<Source[]>;
    }
  >();
  constructor(
    private store: Store,
    private decrypt: (value: string) => string,
    private changed: (id: string) => void,
  ) {}
  private row(source: SourceBinding) {
    const row = this.store.integration(source.integrationId);
    return row?.enabled &&
      (row.type === "ical" || row.type === "home-assistant")
      ? row
      : undefined;
  }
  reconcile() {
    if (this.closed) return;
    for (const [id, discovery] of this.discoveries)
      if (this.store.integration(id)?.revision !== discovery.revision)
        this.discoveries.delete(id);
    const sources = this.store
      .activeBindings()
      .flatMap(({ bindings }) =>
        Object.values(bindings)
          .filter(isCalendarBinding)
          .flatMap(bindingSources),
      )
      .filter((source) => this.row(source));
    const wanted = new Set(sources.map(sourceKey));
    for (const [key, consumer] of this.live) {
      const source = sources.find((source) => sourceKey(source) === key);
      if (!source || this.row(source)?.revision !== consumer.revision) {
        consumer.close();
        this.live.delete(key);
      }
    }
    for (const [key, entry] of this.entries) {
      if (this.row(entry.source)?.revision !== entry.revision) {
        this.remove(entry);
        this.entries.delete(key);
      }
    }
    for (const source of sources) {
      const key = sourceKey(source);
      if (!this.live.has(key)) {
        const consumer = this.acquire(source);
        this.live.set(key, {
          revision: this.row(source)!.revision,
          close: consumer.close,
        });
      }
    }
    if (!wanted.size && !this.entries.size) clearTimeout(this.boundary);
    this.scheduleBoundary();
  }
  private acquire(source: SourceBinding) {
    const row = this.row(source);
    if (!row) return { ready: Promise.resolve(), close: () => {} };
    const key = sourceKey(source);
    let entry = this.entries.get(key);
    if (!entry) {
      let settle!: () => void;
      entry = {
        source,
        revision: row.revision,
        consumers: new Set(),
        abort: new AbortController(),
        failed: false,
        stopped: false,
        busy: false,
        ready: new Promise<void>((resolve) => {
          settle = resolve;
        }),
        settle,
      };
      this.entries.set(key, entry);
      this.queue.push(entry);
    }
    const current = entry;
    const consumer = Symbol();
    current.consumers.add(consumer);
    this.drain();
    this.scheduleBoundary();
    return {
      ready: current.ready,
      close: () => {
        current.consumers.delete(consumer);
        if (!current.consumers.size) {
          this.remove(current);
          if (this.entries.get(key) === current) this.entries.delete(key);
          this.scheduleBoundary();
        }
      },
    };
  }
  private remove(entry: Entry) {
    entry.abort.abort();
    clearTimeout(entry.timer);
    entry.settle();
    this.queue = this.queue.filter((queued) => queued !== entry);
    entry.events = undefined;
    entry.text = undefined;
  }
  private current(entry: Entry) {
    return (
      !this.closed &&
      !entry.abort.signal.aborted &&
      this.entries.get(sourceKey(entry.source)) === entry &&
      this.row(entry.source)?.revision === entry.revision
    );
  }
  private drain() {
    while (!this.closed && this.running < 4 && this.queue.length) {
      const entry = this.queue.shift()!;
      if (!this.current(entry) || entry.busy) continue;
      entry.busy = true;
      this.running++;
      void this.refresh(entry).finally(() => {
        entry.busy = false;
        this.running--;
        this.drain();
      });
    }
  }
  private async read(
    row: IntegrationRow,
    sourceId: string,
    signal: AbortSignal,
    entry?: Entry,
  ) {
    const secret = this.decrypt(row.credentials);
    const now = Date.now();
    // Include ongoing events; extra date padding covers every display timezone.
    const from = now - 2 * DAY,
      to = now + 32 * DAY;
    if (row.type === "ical") {
      if (sourceId !== "calendar") throw new Error();
      const response = await calendarGet(secret, signal, {
        ...(entry?.etag ? { "if-none-match": entry.etag } : {}),
        ...(entry?.modified ? { "if-modified-since": entry.modified } : {}),
      });
      const text = response.status === 304 ? entry?.text : response.body;
      if (text === undefined) throw new Error();
      const events = await parseFeed(text, row.base_url, from, to, signal);
      if (entry) {
        entry.text = text;
        if (response.status === 200) {
          entry.etag = response.etag;
          entry.modified = response.modified;
        }
      }
      return events;
    }
    if (!/^calendar\.[a-z0-9_]{1,200}$/.test(sourceId)) throw new Error();
    const query = new URLSearchParams({
      start: new Date(from).toISOString(),
      end: new Date(to).toISOString(),
    });
    const response = await calendarGet(
      `${baseUrl(row.base_url)}/api/calendars/${encodeURIComponent(sourceId)}?${query}`,
      signal,
      { authorization: `Bearer ${secret}` },
    );
    return homeAssistantEvents(JSON.parse(response.body));
  }
  private async refresh(entry: Entry) {
    entry.attemptedAt = Date.now();
    try {
      const events = await this.read(
        this.row(entry.source)!,
        entry.source.sourceId,
        entry.abort.signal,
        entry,
      );
      if (!this.current(entry)) return;
      const total = [...this.entries.values()].reduce(
        (sum, item) => sum + (item === entry ? 0 : (item.events?.length ?? 0)),
        events.length,
      );
      if (total > 50000) throw new Error("Calendar cache limit.");
      entry.events = events;
      entry.at = Date.now();
      entry.failed = false;
    } catch (error) {
      if (!this.current(entry)) return;
      entry.failed = true;
      if (error instanceof CalendarHttpError) {
        if ([400, 401, 403, 404].includes(error.status)) {
          entry.events = undefined;
          entry.at = undefined;
          entry.text = undefined;
          entry.etag = undefined;
          entry.modified = undefined;
        }
        if (error.authentication) entry.stopped = true;
      }
    } finally {
      entry.settle();
      if (this.current(entry)) {
        this.changed(entry.source.integrationId);
        if (!entry.stopped) {
          entry.timer = setTimeout(() => {
            this.queue.push(entry);
            this.drain();
          }, CALENDAR_REFRESH);
          entry.timer.unref();
        }
        this.scheduleBoundary();
      }
    }
  }
  private scheduleBoundary() {
    clearTimeout(this.boundary);
    if (this.closed || !this.entries.size) return;
    const now = Date.now();
    // Align minute boundaries (including all-day rollover), cap sleep for wall
    // clock adjustments, and hit timed appointment starts/ends exactly.
    let next = Math.min(now + 30000, (Math.floor(now / 60000) + 1) * 60000);
    for (const entry of this.entries.values())
      for (const event of entry.events ?? []) {
        if (event.kind === "timed")
          for (const at of [event.start, event.end]) {
            if (at > now) next = Math.min(next, at);
          }
      }
    this.boundary = setTimeout(
      () => {
        const current = Date.now();
        for (const entry of this.entries.values()) {
          if (
            !entry.stopped &&
            !entry.busy &&
            entry.attemptedAt !== undefined &&
            (current < entry.attemptedAt ||
              current >= entry.attemptedAt + CALENDAR_REFRESH) &&
            !this.queue.includes(entry)
          ) {
            clearTimeout(entry.timer);
            this.queue.push(entry);
          }
        }
        this.drain();
        for (const id of new Set(
          [...this.entries.values()].map((entry) => entry.source.integrationId),
        ))
          this.changed(id);
        this.scheduleBoundary();
      },
      Math.max(50, next - now),
    );
    this.boundary.unref();
  }
  data(binding: CalendarBinding, timezone: string): Datum {
    const now = Date.now();
    const entries = binding.calendars.map((source) => {
      const entry = this.entries.get(sourceKey(source));
      return this.row(source)?.revision === entry?.revision ? entry : undefined;
    });
    const confirmed = entries.filter((entry) => entry?.at !== undefined);
    if (!confirmed.length)
      return emptyDatum(
        { key: "calendar", label: "Calendar", type: "calendar" },
        entries.some((entry) => entry && !entry.failed)
          ? "loading"
          : "unavailable",
      );
    const complete = entries.every(
      (entry) =>
        entry?.at !== undefined &&
        !entry.failed &&
        now >= entry.at &&
        now < entry.at + CALENDAR_MAX_AGE,
    );
    function* candidates(): Iterable<Candidate> {
      for (const [index, source] of binding.calendars.entries()) {
        const key = sourceKey(source);
        for (const event of entries[index]?.events ?? [])
          yield { event, showTitle: source.showTitle, source: key };
      }
    }
    const event = nextAppointment(candidates(), timezone, now);
    const at = Math.min(...confirmed.map((entry) => entry!.at!));
    return {
      type: "calendar",
      status: complete ? "ready" : "stale",
      value: { event, complete },
      unit: null,
      updatedAt: null,
      observedAt: at,
      expiresAt: Math.min(now + 90000, at + CALENDAR_MAX_AGE),
    };
  }
  async preview(bindings: CalendarBinding[], signal?: AbortSignal) {
    const consumers = bindings.flatMap((binding) =>
      binding.calendars.map((source) => this.acquire(source)),
    );
    const close = () => consumers.forEach((consumer) => consumer.close());
    signal?.addEventListener("abort", close, { once: true });
    if (signal?.aborted) close();
    try {
      await Promise.all(consumers.map((consumer) => consumer.ready));
      // Caller must project data before releasing the preview consumers.
      return close;
    } catch (error) {
      close();
      throw error;
    } finally {
      signal?.removeEventListener("abort", close);
    }
  }
  async discover(
    row: IntegrationRow,
    signal: AbortSignal,
    refresh = false,
  ): Promise<Source[]> {
    if (row.type === "ical") return [calendarSource("calendar", row.name)];
    const cached = this.discoveries.get(row.id);
    if (
      !refresh &&
      cached?.revision === row.revision &&
      Date.now() - cached.at < 30000
    )
      return cached.pending;
    const pending = this.readDiscovery(row, signal);
    const entry = { revision: row.revision, at: Date.now(), pending };
    this.discoveries.set(row.id, entry);
    void pending.catch(() => {
      if (this.discoveries.get(row.id) === entry)
        this.discoveries.delete(row.id);
    });
    return pending;
  }
  private async readDiscovery(
    row: IntegrationRow,
    signal: AbortSignal,
  ): Promise<Source[]> {
    const response = await calendarGet(
      `${baseUrl(row.base_url)}/api/calendars`,
      signal,
      {
        authorization: `Bearer ${this.decrypt(row.credentials)}`,
      },
    );
    return z
      .array(
        z.object({
          entity_id: z.string().regex(/^calendar\.[a-z0-9_]{1,200}$/),
          name: z.string().max(10000),
        }),
      )
      .max(10000)
      .parse(JSON.parse(response.body))
      .map((row) => calendarSource(row.entity_id, row.name.slice(0, 200)));
  }
  async test(url: string, timezone: string) {
    if (this.tests >= 4)
      throw new ConnectorError("Too many calendar connection tests.");
    this.tests++;
    const abort = new AbortController();
    this.operations.add(abort);
    try {
      const signal = AbortSignal.any([
        abort.signal,
        AbortSignal.timeout(15000),
      ]);
      const response = await calendarGet(url, signal);
      await parseFeed(
        response.body,
        timezone,
        Date.now() - 2 * DAY,
        Date.now() + 32 * DAY,
        signal,
      );
      return { ok: true };
    } finally {
      this.tests--;
      this.operations.delete(abort);
    }
  }
  retry(id: string) {
    for (const entry of this.entries.values()) {
      if (entry.source.integrationId !== id || !entry.stopped) continue;
      entry.stopped = false;
      this.queue.push(entry);
    }
    this.drain();
  }
  close() {
    this.closed = true;
    clearTimeout(this.boundary);
    for (const entry of this.entries.values()) this.remove(entry);
    this.entries.clear();
    this.live.clear();
    this.discoveries.clear();
    for (const operation of this.operations) operation.abort();
    this.operations.clear();
  }
  health(id: string) {
    const entries = [...this.entries.values()].filter(
      (entry) => entry.source.integrationId === id,
    );
    if (!entries.length) return;
    if (entries.some((entry) => entry.stopped))
      return {
        status: "authentication-error" as const,
        error:
          "Calendar credentials were rejected. Replace the subscription URL or test the saved connection to retry.",
      };
    if (entries.some((entry) => entry.failed))
      return {
        status: "disconnected" as const,
        error:
          "Calendar reads are unavailable or stale. Check its access, feed format, and source limits.",
      };
    if (entries.some((entry) => entry.at === undefined))
      return { status: "connecting" as const, error: null };
    return { status: "connected" as const, error: null };
  }
}
