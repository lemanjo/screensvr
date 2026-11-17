import type { FaceManifest } from "../../src/shared/contracts.js";
import type {
  Datum,
  FaceData,
  PhotoValue,
} from "../../src/shared/face-data.js";
import {
  isForecastValue,
  isWeatherValue,
  projectForecast,
  projectWeather,
} from "../../src/shared/weather.js";

function isPhoto(value: unknown): value is PhotoValue & { url: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const photo = value as Record<string, unknown>;
  return (
    Number.isInteger(photo.count) &&
    (photo.count as number) > 0 &&
    (photo.count as number) <= 10000 &&
    typeof photo.revision === "string" &&
    /^[a-f0-9]{64}$/.test(photo.revision) &&
    typeof photo.url === "string" &&
    /^\/api\/photos\/[A-Za-z0-9_-]{32}$/.test(photo.url)
  );
}
// This is deliberately lightweight: display bundles must not import Zod or
// management code. The server is the authoritative contract validator.
export function frameData(face: FaceManifest, data?: FaceData): FaceData {
  if (face.schemaVersion === 1) return {};
  return Object.fromEntries(
    face.inputs.map((input) => {
      const empty: Datum = {
        type: input.type,
        ...(input.type === "number" && input.quantity
          ? { quantity: input.quantity }
          : {}),
        ...(input.type === "forecast" ? { period: input.period } : {}),
        status: "unbound",
        value: null,
        unit: null,
        updatedAt: null,
        observedAt: null,
        expiresAt: null,
      };
      const value = data?.[input.key];
      if (!value) return [input.key, empty];
      const valued = value.status === "ready" || value.status === "stale";
      const valid =
        value.type === input.type &&
        (input.type === "forecast"
          ? value.period === input.period
          : value.period === undefined) &&
        (input.type !== "number" ||
          !input.quantity ||
          input.quantity === value.quantity) &&
        ["ready", "stale", "loading", "unavailable", "unbound"].includes(
          value.status,
        ) &&
        (!value.quantity ||
          (input.type === "number" &&
            ["temperature", "humidity"].includes(value.quantity))) &&
        (value.unit === null ||
          (typeof value.unit === "string" && value.unit.length <= 32)) &&
        [value.updatedAt, value.observedAt, value.expiresAt].every(
          (time) => time === null || (Number.isSafeInteger(time) && time >= 0),
        ) &&
        (valued
          ? value.observedAt !== null &&
            value.expiresAt !== null &&
            (input.type === "number"
              ? typeof value.value === "number" && Number.isFinite(value.value)
              : input.type === "weather"
                ? isWeatherValue(value.value) &&
                  (value.value.temperature === null ||
                    ["°C", "°F", "K"].includes(value.unit ?? ""))
                : input.type === "forecast"
                  ? isForecastValue(value.value, input.period) &&
                    (value.value.entries.every(
                      (entry) =>
                        entry.temperature === null && entry.low === null,
                    ) ||
                      ["°C", "°F", "K"].includes(value.unit ?? ""))
                  : input.type === "image"
                    ? isPhoto(value.value)
                    : input.type === "boolean"
                      ? typeof value.value === "boolean"
                      : typeof value.value === "string" &&
                        value.value.length <= 200) &&
            (value.quantity !== "temperature" ||
              ["°C", "°F", "K"].includes(value.unit ?? "")) &&
            (value.quantity !== "humidity" || value.unit === "%")
          : value.value === null);
      if (!valid) return [input.key, { ...empty, status: "unavailable" }];
      // Copy only the public fields, never an arbitrary object from an API.
      return [
        input.key,
        {
          type: value.type,
          ...(value.quantity ? { quantity: value.quantity } : {}),
          ...(input.type === "forecast" ? { period: input.period } : {}),
          status: value.status,
          value:
            input.type === "image" && isPhoto(value.value)
              ? {
                  count: value.value.count,
                  revision: value.value.revision,
                  url: value.value.url,
                }
              : input.type === "weather" && isWeatherValue(value.value)
                ? projectWeather(value.value)
                : input.type === "forecast" &&
                    isForecastValue(value.value, input.period)
                  ? projectForecast(value.value)
                  : value.value,
          unit: value.unit,
          updatedAt: value.updatedAt,
          observedAt: value.observedAt,
          expiresAt: value.expiresAt,
        },
      ];
    }),
  );
}
