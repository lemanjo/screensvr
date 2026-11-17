import type { Datum, Source } from "../../shared/face-data.js";

export type EntityState = {
  state: string;
  attributes: Record<string, unknown>;
  updated: number | null;
};
const numeric = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
export function normalize(
  id: string,
  state: EntityState,
  previous?: Source,
): { source: Source; reading: Datum } | undefined {
  if (!/^(sensor|binary_sensor)\.[a-z0-9_]{1,200}$/.test(id)) return;
  const attributes = state.attributes;
  const available = !["unknown", "unavailable"].includes(state.state);
  let unit =
    typeof attributes.unit_of_measurement === "string"
      ? attributes.unit_of_measurement.slice(0, 32)
      : null;
  if (unit === "℃") unit = "°C";
  if (unit === "℉") unit = "°F";
  const binary = id.startsWith("binary_sensor.");
  const reportedQuantity =
    !binary &&
    attributes.device_class === "temperature" &&
    ["°C", "°F", "K"].includes(unit ?? "")
      ? "temperature"
      : !binary && attributes.device_class === "humidity" && unit === "%"
        ? "humidity"
        : undefined;
  const quantity =
    reportedQuantity ??
    (!binary && !available ? previous?.quantity : undefined);
  if (!available && unit === null) unit = previous?.unit ?? null;
  const number = numeric.test(state.state) ? Number(state.state) : NaN;
  const type = binary
    ? "boolean"
    : quantity || unit || Number.isFinite(number)
      ? "number"
      : !available && previous
        ? previous.type
        : "text";
  const value =
    type === "boolean"
      ? state.state === "on"
        ? true
        : state.state === "off"
          ? false
          : null
      : type === "number"
        ? Number.isFinite(number)
          ? number
          : null
        : state.state.length <= 200
          ? state.state
          : null;
  const source: Source = {
    id,
    label:
      typeof attributes.friendly_name === "string"
        ? attributes.friendly_name.slice(0, 80) || id.slice(0, 80)
        : id.slice(0, 80),
    type,
    ...(quantity ? { quantity } : {}),
    unit: type === "number" ? unit : null,
    available: available && value !== null,
  };
  const now = Date.now();
  return {
    source,
    reading: {
      type,
      ...(quantity ? { quantity } : {}),
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
