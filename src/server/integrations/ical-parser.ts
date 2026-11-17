import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { CalendarEvent } from "../../shared/calendar.js";
import { ConnectorError } from "./connector.js";

export type Occurrence = CalendarEvent & { key: string; private: boolean };
const parserPath = createRequire(import.meta.url).resolve("node-ical");

// Only the parser runs in this bounded worker. It has no URL downloader: network
// policy stays in calendar-http, and ATTACH/URL/TZURL are never followed.
const program = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const ical = require(workerData.parserPath);
console.warn = () => { throw new Error("Unsupported calendar timezone"); };
try {
  const checkZone = (date) => {
    if (!(date instanceof Date) || !Number.isFinite(+date)) throw new Error("Invalid date");
    if (!date.tz || date.dateOnly) return;
    if (/^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(date.tz)) return;
    try { new Intl.DateTimeFormat("en", { timeZone: date.tz }); }
    catch { throw new Error("Unknown timezone"); }
  };
  let text = workerData.text.replace(/\r?\n[ \t]/g, "");
  if (!/^BEGIN:VCALENDAR\r?\n/i.test(text.trim()) || !/\r?\nEND:VCALENDAR$/i.test(text.trim()) ||
    (text.match(/^BEGIN:VCALENDAR$/gmi) || []).length !== 1)
    throw new Error("Not an iCalendar feed");
  if ((text.match(/^BEGIN:/gmi) || []).length > 20000) throw new Error("Component limit");
  // Some custom Microsoft identifiers trigger the parser's host-zone fallback
  // without an embedded definition. Reject those rather than inventing a zone.
  for (const match of text.matchAll(/TZID="?(\(no TZ description\)|Customized Time Zone[^";:\r\n]*)/gi)) {
    if (!text.includes("TZID:" + match[1])) throw new Error("Missing custom timezone");
  }
  // Give floating date-times an explicit source timezone, never the host zone.
  text = text.replace(/^BEGIN:VEVENT\r?\n[\s\S]*?^END:VEVENT/gmi, (block) =>
    block.replace(/^(DTSTART|DTEND|RECURRENCE-ID|EXDATE|RDATE)((?:;[^:\r\n]*)?):([^\r\n]*)/gmi,
    (line, name, params, value) => {
      for (const part of value.split(",")) {
        const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(part);
        if (!match) throw new Error("Invalid calendar date");
        const date = match[1] + "-" + match[2] + "-" + match[3];
        const at = Date.parse(date + "T00:00:00Z");
        if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== date ||
          (match[4] && (+match[4] > 23 || +match[5] > 59 || +match[6] > 59)))
          throw new Error("Invalid calendar date");
      }
      if (!/TZID=/i.test(params) && /^\d{8}T\d{6}(?:,\d{8}T\d{6})*$/.test(value))
        return name + params + ";TZID=" + workerData.timezone + ":" + value;
      return line;
    }));
  // RDATE is not expanded by node-ical. Parse each value through its date parser
  // and later expand it as an extra occurrence of the same series.
  const additions = new Map();
  text = text.replace(/^BEGIN:VEVENT\r?\n([\s\S]*?)^END:VEVENT/gmi, (block, content) => {
    const uid = /^UID:(.*)$/mi.exec(content)?.[1]?.trim();
    if (!uid || uid.length > 4096) throw new Error("Missing event identity");
    if (uid) for (const match of content.matchAll(/^RDATE([^:]*):([^\r\n]*)/gmi)) {
      if (/VALUE=PERIOD/i.test(match[1]) || match[2].includes("/")) throw new Error("RDATE periods unsupported");
      const dates = additions.get(uid) || [];
      for (const value of match[2].split(",")) {
        const parsed = ical.sync.parseICS("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:extra\r\nDTSTART" + match[1] + ":" + value + "\r\nEND:VEVENT\r\nEND:VCALENDAR");
        checkZone(parsed.extra.start);
        dates.push(parsed.extra.start);
      }
      additions.set(uid, dates);
    }
    if (/RECURRENCE-ID[^:\r\n]*;RANGE=/i.test(content)) throw new Error("Recurrence ranges unsupported");
    return block;
  });
  const parsed = ical.sync.parseICS(text);
  const events = [];
  const seen = new Set();
  const day = (date) => String(date.getFullYear()).padStart(4, "0") + "-" +
    String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
  const label = (value) => {
    const text = typeof value === "string" ? value : value?.val;
    return typeof text === "string" ? text.replace(/\p{Cc}/gu, " ").slice(0, 200) : null;
  };
  const upper = value => typeof value === "string" ? value.toUpperCase() : "";
  for (const event of Object.values(parsed)) {
    if (!event || event.type !== "VEVENT" || upper(event.status) === "CANCELLED" || upper(event.method) === "CANCEL" || upper(parsed.vcalendar?.method) === "CANCEL") continue;
    if (!(event.start instanceof Date) || !Number.isFinite(+event.start)) throw new Error("Invalid event start");
    for (const item of [event, ...new Set(Object.values(event.recurrences || {}))]) {
      if (item.start) checkZone(item.start);
      if (item.end) checkZone(item.end);
      if (item.recurrenceid) checkZone(item.recurrenceid);
      for (const date of Object.values(item.exdate || {})) checkZone(date);
    }
    const options = { from: new Date(workerData.from), to: new Date(workerData.to), expandOngoing: true, maxIterations: 10000 };
    const instances = ical.expandRecurringEvent(event, options);
    for (const start of additions.get(event.uid) || []) {
      const excluded = Object.values(event.exdate || {}).some(date => +date === +start);
      const override = Object.values(event.recurrences || {}).find(item => +item.recurrenceid === +start);
      if (excluded || override) continue;
      const extra = { ...event, start, rrule: undefined, recurrences: undefined };
      if (event.end) {
        extra.end = new Date(+start + (+event.end - +event.start));
        if (event.start.dateOnly) extra.end = new Date(start.getFullYear(), start.getMonth(), start.getDate() +
          Math.round((Date.UTC(event.end.getFullYear(), event.end.getMonth(), event.end.getDate()) -
          Date.UTC(event.start.getFullYear(), event.start.getMonth(), event.start.getDate())) / 86400000));
      }
      instances.push(...ical.expandRecurringEvent(extra, options));
    }
    for (const instance of instances) {
      const item = instance.event;
      if (upper(item.status) === "CANCELLED" || upper(item.transparency) === "TRANSPARENT") continue;
      const start = +instance.start, end = +instance.end;
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end < start) throw new Error("Invalid event range");
      const key = String(event.uid) + ":" + start;
      if (seen.has(key)) continue;
      seen.add(key);
      const classifications = [item.class, event.class].filter(value => value !== undefined).map(upper);
      if (classifications.some(value => !["PRIVATE", "CONFIDENTIAL", "PUBLIC"].includes(value))) throw new Error("Invalid privacy classification");
      const common = { key, private: classifications.some(value => value === "PRIVATE" || value === "CONFIDENTIAL"), title: label(instance.summary) };
      events.push(instance.isFullDay
        ? { ...common, kind: "all-day", startDate: day(instance.start), endDate: day(instance.end) }
        : { ...common, kind: "timed", start, end });
      if (events.length > 10000) throw new Error("Occurrence limit");
    }
  }
  parentPort.postMessage({ events });
} catch {
  parentPort.postMessage({ error: true });
}
`;

export function parseFeed(
  text: string,
  timezone: string,
  from: number,
  to: number,
  signal: AbortSignal,
): Promise<Occurrence[]> {
  return new Promise((resolve, reject) => {
    if (signal.aborted)
      return reject(new ConnectorError("Calendar parsing cancelled."));
    const worker = new Worker(program, {
      eval: true,
      workerData: { text, timezone, from, to, parserPath },
      // Date-only arithmetic in the parser uses local getters. Workers have an
      // explicit zone, and floating timed values were made explicit above.
      env: { ...process.env, TZ: timezone },
      resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 },
    });
    let settled = false;
    const finish = (events?: Occurrence[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      void worker.terminate();
      if (events) resolve(events);
      else
        reject(
          new ConnectorError(
            "Calendar feed is invalid, unsupported, or exceeds parsing/recurrence limits.",
          ),
        );
    };
    const abort = () => finish();
    const timer = setTimeout(abort, 5000);
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (result) =>
      finish(result.error ? undefined : result.events),
    );
    worker.once("error", abort);
    worker.once("exit", () => {
      if (!settled) finish();
    });
  });
}
