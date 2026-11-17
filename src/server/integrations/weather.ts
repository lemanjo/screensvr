import { Temporal } from "@js-temporal/polyfill";
import { emptyDatum, type Source } from "../../shared/face-data.js";
import type {
  ForecastEntry,
  ForecastPeriod,
  WeatherCondition,
} from "../../shared/weather.js";
import type { Reading } from "./connector.js";
import type { EntityState } from "./normalize.js";

export const FORECAST_REFRESH = 15 * 60 * 1000;
export const FORECAST_MAX_AGE = 60 * 60 * 1000;
const conditions: Record<string, WeatherCondition> = {
  sunny: "clear-day",
  "clear-night": "clear-night",
  partlycloudy: "partly-cloudy",
  cloudy: "cloudy",
  rainy: "rain",
  pouring: "heavy-rain",
  snowy: "snow",
  "snowy-rainy": "sleet",
  hail: "hail",
  fog: "fog",
  windy: "wind",
  "windy-variant": "windy-cloudy",
  lightning: "thunderstorm",
  "lightning-rainy": "thunderstorm-rain",
};
export function condition(value: unknown): WeatherCondition | null {
  return typeof value === "string" && Object.hasOwn(conditions, value)
    ? conditions[value]
    : null;
}
export function temperatureUnit(value: unknown) {
  if (value === "℃") return "°C";
  if (value === "℉") return "°F";
  return ["°C", "°F", "K"].includes(value as string) ? (value as string) : null;
}
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
export function weatherId(id: string) {
  const match = /^(weather\.[a-z0-9_]{1,200})(?::(daily|hourly))?$/.exec(id);
  return match
    ? { entityId: match[1], period: match[2] as ForecastPeriod | undefined }
    : undefined;
}
export function weatherAvailable(state?: EntityState) {
  return Boolean(state && !["unknown", "unavailable"].includes(state.state));
}
export function supportsForecast(state: EntityState, period: ForecastPeriod) {
  const features = state.attributes.supported_features;
  return (
    typeof features === "number" &&
    Number.isSafeInteger(features) &&
    features >= 0 &&
    Boolean(features & (period === "daily" ? 1 : 2))
  );
}
export function weatherSource(
  entityId: string,
  state: EntityState,
  period?: ForecastPeriod,
): Source {
  const label =
    typeof state.attributes.friendly_name === "string"
      ? state.attributes.friendly_name.slice(0, 60) || entityId.slice(0, 60)
      : entityId.slice(0, 60);
  return {
    id: period ? `${entityId}:${period}` : entityId,
    label: period ? `${label} · ${period} forecast` : label,
    type: period ? "forecast" : "weather",
    ...(period ? { period } : {}),
    unit: temperatureUnit(state.attributes.temperature_unit),
    available:
      weatherAvailable(state) && (!period || supportsForecast(state, period)),
  };
}
export function weatherSources(entityId: string, state: EntityState): Source[] {
  const parsed = weatherId(entityId);
  if (!parsed || parsed.period) return [];
  return [
    weatherSource(entityId, state),
    ...(["daily", "hourly"] as const)
      .filter((period) => supportsForecast(state, period))
      .map((period) => weatherSource(entityId, state, period)),
  ];
}
export function currentWeather(entityId: string, state: EntityState): Reading {
  const source = weatherSource(entityId, state);
  const value = {
    temperature: source.unit ? finite(state.attributes.temperature) : null,
    condition: condition(state.state),
  };
  source.available &&= value.temperature !== null || value.condition !== null;
  const now = Date.now();
  return {
    source,
    reading: {
      ...emptyDatum({ key: "weather", label: "Weather", type: "weather" }),
      status: source.available ? "ready" : "unavailable",
      value: source.available ? value : null,
      unit: source.unit,
      updatedAt:
        state.updated !== null &&
        Number.isSafeInteger(state.updated) &&
        state.updated >= 0
          ? state.updated
          : null,
      observedAt: now,
      expiresAt: now + 90000,
    },
  };
}
export function forecastReading(
  entityId: string,
  period: ForecastPeriod,
  state: EntityState,
  forecast: unknown,
): Reading {
  const source = weatherSource(entityId, state, period);
  const entries: ForecastEntry[] = [];
  // The socket already bounds bytes. Also bound parsing work and retained rows.
  if (source.available && Array.isArray(forecast) && forecast.length <= 1000)
    for (const row of forecast) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      let at: number;
      try {
        if (typeof row.datetime !== "string" || row.datetime.length > 80)
          continue;
        at = Temporal.Instant.from(row.datetime).epochMilliseconds;
      } catch {
        continue;
      }
      if (!Number.isSafeInteger(at) || at < 0) continue;
      // Keep today's daily entry even when its timestamp is before local noon.
      if (at < Date.now() - (period === "daily" ? 48 * 3600000 : 3600000))
        continue;
      const temperature = source.unit ? finite(row.temperature) : null;
      const low =
        source.unit && period === "daily" ? finite(row.templow) : null;
      const normalized = condition(row.condition);
      if (
        (temperature === null && low === null && normalized === null) ||
        (temperature !== null && low !== null && low > temperature)
      )
        continue;
      entries.push({ at, temperature, low, condition: normalized });
    }
  const selected = entries
    .sort((a, b) => a.at - b.at)
    .filter(
      (entry, index, all) => index === 0 || entry.at !== all[index - 1].at,
    )
    .slice(0, period === "daily" ? 7 : 24);
  source.available &&= selected.length > 0;
  const now = Date.now();
  return {
    source,
    validUntil: now + FORECAST_MAX_AGE,
    reading: {
      ...emptyDatum({
        key: "forecast",
        label: "Forecast",
        type: "forecast",
        period,
      }),
      status: source.available ? "ready" : "unavailable",
      value: source.available ? { entries: selected } : null,
      unit: source.unit,
      // HA does not supply a forecast issuance timestamp.
      updatedAt: null,
      observedAt: now,
      expiresAt: now + 90000,
    },
  };
}
