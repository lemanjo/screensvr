import { z } from "zod";
import { isCalendarValue } from "./calendar.js";
import {
  isForecastValue,
  weatherConditions,
  type ForecastPeriod,
} from "./weather.js";

export const safeKey = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/)
  .refine(
    (value) => !["__proto__", "constructor", "prototype"].includes(value),
  );
const base = {
  key: safeKey,
  label: z.string().min(1).max(80),
  description: z.string().max(200).optional(),
};
export const scalarInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("number"),
      quantity: z.enum(["temperature", "humidity"]).optional(),
    })
    .strict(),
  z.object({ ...base, type: z.literal("boolean") }).strict(),
  z.object({ ...base, type: z.literal("text") }).strict(),
]);
export const inputSchema = z.union([
  scalarInputSchema,
  z.object({ ...base, type: z.literal("image") }).strict(),
]);
export const weatherInputSchema = z.union([
  inputSchema,
  z.object({ ...base, type: z.literal("weather") }).strict(),
  z
    .object({
      ...base,
      type: z.literal("forecast"),
      period: z.enum(["daily", "hourly"]),
    })
    .strict(),
]);
export const calendarInputSchema = z.union([
  weatherInputSchema,
  z.object({ ...base, type: z.literal("calendar") }).strict(),
]);
export type FaceInput = z.infer<typeof calendarInputSchema>;
// Zod deliberately strips __proto__ while parsing records. Reject it before
// parsing so unsafe submitted keys cannot silently disappear.
const safeObject = z.unknown().superRefine((value, context) => {
  if (
    value &&
    typeof value === "object" &&
    Object.keys(value).some((key) => !safeKey.safeParse(key).success)
  )
    context.addIssue({
      code: "custom",
      message: "Object keys must be safe input keys.",
    });
});
export const sourceBindingSchema = z
  .object({
    integrationId: z.string().uuid(),
    sourceId: z
      .string()
      .min(1)
      .max(240)
      .refine((value) => !/\p{Cc}/u.test(value), "Invalid source ID."),
  })
  .strict();
export type SourceBinding = z.infer<typeof sourceBindingSchema>;
export const calendarBindingSchema = z
  .object({
    calendars: z
      .array(
        sourceBindingSchema.extend({
          showTitle: z.boolean().default(false),
        }),
      )
      .min(1)
      .max(8),
  })
  .strict()
  .refine(
    ({ calendars }) =>
      new Set(
        calendars.map((source) => `${source.integrationId}:${source.sourceId}`),
      ).size === calendars.length,
    "Select each calendar only once.",
  );
export type CalendarBinding = z.infer<typeof calendarBindingSchema>;
export function isCalendarBinding(
  binding: Bindings[string],
): binding is CalendarBinding {
  return "calendars" in binding;
}
export function bindingSources(binding: Bindings[string]): SourceBinding[] {
  return isCalendarBinding(binding) ? binding.calendars : [binding];
}
export const bindingsSchema = safeObject
  .pipe(
    z.record(safeKey, z.union([sourceBindingSchema, calendarBindingSchema])),
  )
  .refine(
    (value) => Object.keys(value).length <= 16,
    "At most 16 inputs are supported.",
  );
export type Bindings = z.infer<typeof bindingsSchema>;

const timestamp = z.number().int().nonnegative().nullable();
export const photoValueSchema = z
  .object({
    count: z.number().int().min(1).max(10000),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    // null is used internally, before granting scoped image access.
    url: z
      .string()
      .regex(/^\/api\/photos\/[A-Za-z0-9_-]{32}$/)
      .nullable(),
  })
  .strict();
export type PhotoValue = z.infer<typeof photoValueSchema>;
export const weatherValueSchema = z
  .object({
    temperature: z.number().finite().nullable(),
    condition: z.enum(weatherConditions).nullable(),
  })
  .strict()
  .refine((value) => value.temperature !== null || value.condition !== null);
export const forecastValueSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            at: z.number().int().nonnegative(),
            temperature: z.number().finite().nullable(),
            low: z.number().finite().nullable(),
            condition: z.enum(weatherConditions).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(24),
  })
  .strict();
export const calendarValueSchema = z
  .object({
    event: z.union([
      z
        .object({
          kind: z.literal("timed"),
          start: z.number().int().nonnegative(),
          end: z.number().int().nonnegative(),
          title: z.string().max(200).nullable(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("all-day"),
          startDate: z.string(),
          endDate: z.string(),
          title: z.string().max(200).nullable(),
        })
        .strict(),
      z.null(),
    ]),
    complete: z.boolean(),
  })
  .strict()
  .refine(isCalendarValue, "Invalid calendar value.");
export const datumSchema = z
  .object({
    type: z.enum([
      "number",
      "boolean",
      "text",
      "image",
      "weather",
      "forecast",
      "calendar",
    ]),
    quantity: z.enum(["temperature", "humidity"]).optional(),
    period: z.enum(["daily", "hourly"]).optional(),
    status: z.enum(["unbound", "loading", "ready", "unavailable", "stale"]),
    value: z.union([
      z.number().finite(),
      z.boolean(),
      z.string().max(200),
      photoValueSchema,
      weatherValueSchema,
      forecastValueSchema,
      calendarValueSchema,
      z.null(),
    ]),
    unit: z.string().max(32).nullable(),
    updatedAt: timestamp,
    observedAt: timestamp,
    expiresAt: timestamp,
  })
  .strict()
  .superRefine((datum, context) => {
    const valued = datum.status === "ready" || datum.status === "stale";
    const validType =
      datum.type === "calendar"
        ? isCalendarValue(datum.value)
        : datum.type === "image"
          ? photoValueSchema.safeParse(datum.value).success
          : datum.type === "weather"
            ? weatherValueSchema.safeParse(datum.value).success
            : datum.type === "forecast"
              ? Boolean(
                  datum.period && isForecastValue(datum.value, datum.period),
                )
              : datum.type === "text"
                ? typeof datum.value === "string"
                : typeof datum.value === datum.type;
    const weatherTemperatures =
      valued &&
      ((datum.type === "weather" &&
        weatherValueSchema.safeParse(datum.value).data?.temperature !== null) ||
        (datum.type === "forecast" &&
          forecastValueSchema
            .safeParse(datum.value)
            .data?.entries.some(
              (entry) => entry.temperature !== null || entry.low !== null,
            )));
    if (
      (valued &&
        (!validType ||
          datum.observedAt === null ||
          datum.expiresAt === null)) ||
      (!valued && datum.value !== null) ||
      (datum.type === "forecast"
        ? !datum.period
        : datum.period !== undefined) ||
      (datum.type === "calendar" && datum.unit !== null) ||
      (datum.type === "calendar" &&
        datum.status === "ready" &&
        isCalendarValue(datum.value) &&
        !datum.value.complete) ||
      (weatherTemperatures && !["°C", "°F", "K"].includes(datum.unit ?? "")) ||
      (datum.quantity && datum.type !== "number") ||
      (datum.quantity === "temperature" &&
        valued &&
        !["°C", "°F", "K"].includes(datum.unit ?? "")) ||
      (datum.quantity === "humidity" && valued && datum.unit !== "%")
    )
      context.addIssue({ code: "custom", message: "Invalid input reading." });
  });
export type Datum = z.infer<typeof datumSchema>;
export type FaceData = Record<string, Datum>;
export const faceDataSchema = safeObject
  .pipe(z.record(safeKey, datumSchema))
  .refine((value) => Object.keys(value).length <= 16);

export function emptyDatum(
  input: FaceInput,
  status: Exclude<Datum["status"], "ready" | "stale"> = "unbound",
): Datum {
  return {
    type: input.type,
    ...(input.type === "number" && input.quantity
      ? { quantity: input.quantity }
      : {}),
    ...(input.type === "forecast" ? { period: input.period } : {}),
    status,
    value: null,
    unit: null,
    updatedAt: null,
    observedAt: null,
    expiresAt: null,
  };
}

export type Source = {
  id: string;
  label: string;
  type: FaceInput["type"];
  quantity?: "temperature" | "humidity";
  period?: ForecastPeriod;
  unit: string | null;
  available: boolean;
  kind?: "folder" | "file" | "album";
};
export function compatible(input: FaceInput, source: Source) {
  return (
    input.type === source.type &&
    (input.type !== "forecast" || input.period === source.period) &&
    (input.type !== "number" ||
      !input.quantity ||
      input.quantity === source.quantity)
  );
}

type IntegrationBase = {
  id: string;
  name: string;
  enabled: boolean;
  revision: number;
  hasCredentials: boolean;
  status:
    | "connecting"
    | "connected"
    | "disconnected"
    | "authentication-error"
    | "error"
    | "disabled";
  error: string | null;
  usage: { id: string; name: string }[];
};
export type Integration = IntegrationBase &
  (
    | { type: "home-assistant"; baseUrl: string }
    | { type: "immich"; baseUrl: string }
    | { type: "mounted-folder"; folder: string }
    | { type: "ical"; timezone: string }
  );
