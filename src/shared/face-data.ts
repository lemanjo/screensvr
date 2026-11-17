import { z } from "zod";

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
export const inputSchema = z.discriminatedUnion("type", [
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
export type FaceInput = z.infer<typeof inputSchema>;
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
export const bindingsSchema = safeObject
  .pipe(
    z.record(
      safeKey,
      z
        .object({
          integrationId: z.string().uuid(),
          sourceId: z
            .string()
            .min(1)
            .max(240)
            .refine((value) => !/\p{Cc}/u.test(value), "Invalid source ID."),
        })
        .strict(),
    ),
  )
  .refine(
    (value) => Object.keys(value).length <= 16,
    "At most 16 inputs are supported.",
  );
export type Bindings = z.infer<typeof bindingsSchema>;

const timestamp = z.number().int().nonnegative().nullable();
export const datumSchema = z
  .object({
    type: z.enum(["number", "boolean", "text"]),
    quantity: z.enum(["temperature", "humidity"]).optional(),
    status: z.enum(["unbound", "loading", "ready", "unavailable", "stale"]),
    value: z.union([
      z.number().finite(),
      z.boolean(),
      z.string().max(200),
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
      datum.type === "text"
        ? typeof datum.value === "string"
        : typeof datum.value === datum.type;
    if (
      (valued &&
        (!validType ||
          datum.observedAt === null ||
          datum.expiresAt === null)) ||
      (!valued && datum.value !== null) ||
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
  unit: string | null;
  available: boolean;
};
export function compatible(input: FaceInput, source: Source) {
  return (
    input.type === source.type &&
    (input.type !== "number" ||
      !input.quantity ||
      input.quantity === source.quantity)
  );
}

export type Integration = {
  id: string;
  type: "home-assistant";
  name: string;
  baseUrl: string;
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
