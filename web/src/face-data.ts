import type { FaceManifest } from "../../src/shared/contracts.js";
import type { Datum, FaceData } from "../../src/shared/face-data.js";

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
              : input.type === "image"
                ? value.value !== null &&
                  typeof value.value === "object" &&
                  Number.isInteger(value.value.count) &&
                  value.value.count > 0 &&
                  value.value.count <= 10000 &&
                  typeof value.value.revision === "string" &&
                  /^[a-f0-9]{64}$/.test(value.value.revision) &&
                  typeof value.value.url === "string" &&
                  /^\/api\/photos\/[A-Za-z0-9_-]{32}$/.test(value.value.url)
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
          status: value.status,
          value:
            input.type === "image" &&
            value.value &&
            typeof value.value === "object"
              ? {
                  count: value.value.count,
                  revision: value.value.revision,
                  url: value.value.url,
                }
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
