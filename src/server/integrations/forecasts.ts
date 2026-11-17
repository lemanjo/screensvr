import { emptyDatum } from "../../shared/face-data.js";
import type { ForecastPeriod } from "../../shared/weather.js";
import type { Reading, Watch } from "./connector.js";
import type { EntityState } from "./normalize.js";
import {
  FORECAST_REFRESH,
  forecastReading,
  supportsForecast,
  weatherAvailable,
  weatherSource,
} from "./weather.js";

type Entry = {
  entityId: string;
  period: ForecastPeriod;
  state: EntityState;
  value: Reading;
  listeners: Set<() => void>;
  ready: Promise<void>;
  settle: () => void;
  deadline: ReturnType<typeof setTimeout>;
  timer?: ReturnType<typeof setTimeout>;
  watch?: Watch;
  generation: number;
  enabled: boolean;
  queued: boolean;
};
type Subscribe = (
  entityId: string,
  period: ForecastPeriod,
  callback: (forecast: unknown) => void,
) => Watch;

// Shared by live selections and draft previews. No unselected forecast cache,
// background refresh, or subscription survives the last consumer.
export class Forecasts {
  private entries = new Map<string, Entry>();
  private queue: Entry[] = [];
  private running = 0;
  private closed = false;
  constructor(private subscribe: Subscribe) {}

  acquire(
    entityId: string,
    period: ForecastPeriod,
    state: EntityState,
    changed: () => void,
  ) {
    const key = `${entityId}:${period}`;
    let entry = this.entries.get(key);
    if (!entry) {
      let settle!: () => void;
      const ready = new Promise<void>((resolve) => (settle = resolve));
      entry = {
        entityId,
        period,
        state,
        value: {
          source: weatherSource(entityId, state, period),
          retainPrevious: true,
          reading: emptyDatum(
            { key: "forecast", label: "Forecast", type: "forecast", period },
            "loading",
          ),
        },
        listeners: new Set(),
        ready,
        settle,
        deadline: setTimeout(() => {
          if (entry!.value.reading.status === "loading") this.failed(entry!);
        }, 10000),
        generation: 0,
        enabled: false,
        queued: false,
      };
      entry.deadline.unref();
      this.entries.set(key, entry);
    }
    const selected = entry;
    selected.listeners.add(changed);
    this.update(selected, state);
    let active = true;
    return {
      ready: selected.ready,
      get reading() {
        return selected.value;
      },
      update: (value?: EntityState) => {
        if (active) this.update(selected, value);
      },
      close: () => {
        if (!active) return;
        active = false;
        selected.listeners.delete(changed);
        if (selected.listeners.size) return;
        this.entries.delete(key);
        this.stop(selected);
        this.queue = this.queue.filter((item) => item !== selected);
      },
    };
  }
  private emit(entry: Entry) {
    for (const changed of entry.listeners) changed();
  }
  private stop(entry: Entry) {
    entry.generation++;
    clearTimeout(entry.deadline);
    clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.watch?.close();
    entry.watch = undefined;
    entry.settle();
  }
  private update(entry: Entry, state?: EntityState) {
    const previousUnit = entry.value.source.unit;
    if (state) entry.state = state;
    const source = weatherSource(entry.entityId, entry.state, entry.period);
    const enabled =
      weatherAvailable(state) &&
      Boolean(state && supportsForecast(state, entry.period));
    if (!enabled) {
      entry.enabled = false;
      this.stop(entry);
      entry.value = forecastReading(
        entry.entityId,
        entry.period,
        { ...entry.state, state: "unavailable" },
        null,
      );
      this.emit(entry);
    } else if (!entry.enabled || source.unit !== previousUnit) {
      entry.enabled = true;
      // Never reinterpret cached temperatures after an upstream unit change.
      if (source.unit !== previousUnit) {
        this.stop(entry);
        entry.value = {
          source,
          reading: emptyDatum(
            {
              key: "forecast",
              label: "Forecast",
              type: "forecast",
              period: entry.period,
            },
            "loading",
          ),
        };
      }
      this.enqueue(entry);
    }
  }
  private current(entry: Entry) {
    return (
      !this.closed &&
      entry.enabled &&
      this.entries.get(`${entry.entityId}:${entry.period}`) === entry
    );
  }
  private enqueue(entry: Entry) {
    if (!this.current(entry) || entry.queued) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.queued = true;
    this.queue.push(entry);
    this.drain();
  }
  private drain() {
    while (this.running < 4 && this.queue.length) {
      const entry = this.queue.shift()!;
      entry.queued = false;
      if (!this.current(entry)) continue;
      this.running++;
      void this.refresh(entry).finally(() => {
        this.running--;
        this.drain();
      });
    }
  }
  private async refresh(entry: Entry) {
    entry.watch?.close();
    const generation = ++entry.generation;
    try {
      const watch = this.subscribe(entry.entityId, entry.period, (forecast) => {
        if (!this.current(entry) || generation !== entry.generation) return;
        entry.value = forecastReading(
          entry.entityId,
          entry.period,
          entry.state,
          forecast,
        );
        this.emit(entry);
      });
      entry.watch = watch;
      await watch.ready;
    } catch {
      if (!this.current(entry) || generation !== entry.generation) return;
      entry.watch?.close();
      entry.watch = undefined;
      this.failed(entry);
    }
    if (!this.current(entry) || generation !== entry.generation) return;
    clearTimeout(entry.deadline);
    entry.settle();
    // Keep the last successful response's age ceiling even while ping succeeds.
    entry.timer = setTimeout(() => this.enqueue(entry), FORECAST_REFRESH);
    entry.timer.unref();
  }
  private failed(entry: Entry) {
    const reading = entry.value.reading;
    entry.value = {
      ...entry.value,
      retainPrevious: true,
      reading: {
        ...reading,
        status: reading.value === null ? "unavailable" : "stale",
      },
    };
    entry.settle();
    this.emit(entry);
  }
  close() {
    this.closed = true;
    for (const entry of this.entries.values()) this.stop(entry);
    this.entries.clear();
    this.queue = [];
  }
}
