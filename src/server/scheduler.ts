import { Temporal } from "@js-temporal/polyfill";
import type { ScheduleEntry } from "../shared/scenes.js";
import type { Store } from "./db.js";

/** Resolve weekly wall-clock entries into real instants, including DST gaps/folds. */
export function resolveSchedule(
  entries: ScheduleEntry[],
  timezone: string,
  now: number,
) {
  const today = Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(timezone)
    .toPlainDate();
  const occurrences: { at: number; sceneId: string; order: string }[] = [];
  for (let offset = -7; offset <= 7; offset++) {
    const date = today.add({ days: offset });
    for (const entry of entries) {
      if (!entry.days.includes(date.dayOfWeek)) continue;
      const requested = date.toPlainDateTime(
        Temporal.PlainTime.from(entry.time),
      );
      let zoned = requested.toZonedDateTime(timezone, {
        disambiguation: "compatible",
      });
      // compatible chooses the first occurrence in a fold. In a gap, apply at
      // the jump itself, not at a shifted time later in the following hour.
      if (!zoned.toPlainDateTime().equals(requested)) {
        zoned =
          zoned.add({ nanoseconds: 1 }).getTimeZoneTransition("previous") ??
          zoned;
      }
      occurrences.push({
        at: zoned.epochMilliseconds,
        sceneId: entry.sceneId,
        order: `${date}/${entry.time}`,
      });
    }
  }
  occurrences.sort((a, b) => a.at - b.at || a.order.localeCompare(b.order));
  const current = occurrences.filter((entry) => entry.at <= now).at(-1);
  const nextAt = occurrences.find((entry) => entry.at > now)?.at;
  // At a DST jump multiple skipped entries can share one instant: last wins.
  const next = occurrences.filter((entry) => entry.at === nextAt).at(-1);
  return { current, next };
}

export class Scheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private generations = new Map<string, string>();
  private running = false;
  private closed = false;
  constructor(
    private store: Store,
    private changed: (ids: string[]) => void,
  ) {}

  reconcile() {
    if (this.closed || this.running) return;
    this.running = true;
    clearTimeout(this.timer);
    try {
      const changed: string[] = [];
      const ids = new Set<string>();
      let next = this.store.now() + 30000;
      for (const device of this.store.devices()) {
        ids.add(device.id);
        const selection = this.store.selection(device.id)!;
        if (this.generations.get(device.id) !== selection.generation) {
          this.generations.set(device.id, selection.generation);
          changed.push(device.id);
        }
        if (selection.next) next = Math.min(next, selection.next.at);
      }
      for (const id of this.generations.keys())
        if (!ids.has(id)) this.generations.delete(id);
      if (changed.length) this.changed(changed);
      this.timer = setTimeout(
        () => this.reconcile(),
        Math.max(1, next - this.store.now()),
      );
      this.timer.unref();
    } finally {
      this.running = false;
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.generations.clear();
  }
}
