import { z } from "zod";
import {
  inputSchema,
  scalarInputSchema,
  type Bindings,
  type FaceData,
} from "./face-data.js";

const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/);
const base = { key, label: z.string().min(1).max(80) };
const settingSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("color"),
      default: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    })
    .strict(),
  z
    .object({ ...base, type: z.literal("boolean"), default: z.boolean() })
    .strict(),
  z
    .object({ ...base, type: z.literal("text"), default: z.string().max(200) })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("number"),
      default: z.number().finite(),
      min: z.number().finite(),
      max: z.number().finite(),
      step: z.number().positive().optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("select"),
      default: z.string(),
      options: z
        .array(
          z
            .object({
              label: z.string().min(1).max(80),
              value: z.string().min(1).max(80),
            })
            .strict(),
        )
        .min(1)
        .max(30),
    })
    .strict(),
]);

const manifestFields = {
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  version: z
    .string()
    .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
    .max(40),
  name: z.string().min(1).max(80),
  description: z.string().max(500),
  author: z.string().max(80).optional(),
  entry: z.literal("index.html"),
  settings: z.array(settingSchema).max(32),
};
export const manifestSchema = z
  .discriminatedUnion("schemaVersion", [
    z.object({ ...manifestFields, schemaVersion: z.literal(1) }).strict(),
    z
      .object({
        ...manifestFields,
        schemaVersion: z.literal(2),
        inputs: z.array(scalarInputSchema).max(16),
      })
      .strict(),
    z
      .object({
        ...manifestFields,
        schemaVersion: z.literal(3),
        inputs: z.array(inputSchema).max(16),
      })
      .strict(),
  ])
  .superRefine((manifest, context) => {
    if (
      manifest.schemaVersion !== 1 &&
      new Set(manifest.inputs.map((input) => input.key)).size !==
        manifest.inputs.length
    )
      context.addIssue({
        code: "custom",
        message: "Input keys must be unique.",
      });
    const keys = new Set<string>();
    for (const setting of manifest.settings) {
      if (
        keys.has(setting.key) ||
        ["__proto__", "constructor", "prototype"].includes(setting.key)
      ) {
        context.addIssue({
          code: "custom",
          message: "Setting keys must be unique and safe.",
        });
      }
      keys.add(setting.key);
      if (
        setting.type === "number" &&
        (setting.min > setting.max ||
          setting.default < setting.min ||
          setting.default > setting.max)
      ) {
        context.addIssue({
          code: "custom",
          message: `Invalid number range for ${setting.key}.`,
        });
      }
      if (
        setting.type === "select" &&
        (!setting.options.some((o) => o.value === setting.default) ||
          new Set(setting.options.map((o) => o.value)).size !==
            setting.options.length)
      ) {
        context.addIssue({
          code: "custom",
          message: `Invalid options for ${setting.key}.`,
        });
      }
    }
  });

export type FaceManifest = z.infer<typeof manifestSchema>;
export type Setting = FaceManifest["settings"][number];
export type Settings = Record<string, string | number | boolean>;
export type Face = { manifest: FaceManifest; builtin: boolean };
export type DisplayState = {
  id: string;
  displayUrl: string;
  name: string;
  timezone: string;
  revision: number;
  face: FaceManifest;
  settings: Settings;
  data: FaceData;
  epoch: string;
  sequence: number;
};
export type Device = {
  id: string;
  displayUrl: string;
  name: string;
  timezone: string;
  revision: number;
  faceId: string;
  settings: Settings;
  bindings: Bindings;
  data: FaceData;
  online: boolean;
  lastSeen: number | null;
};

export function validateSettings(
  manifest: FaceManifest,
  input: unknown,
): Settings {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Settings must be an object.");
  const values = input as Record<string, unknown>;
  const keys = new Set(manifest.settings.map((s) => s.key));
  if (Object.keys(values).some((k) => !keys.has(k)))
    throw new Error("Unknown setting.");
  return Object.fromEntries(
    manifest.settings.map((setting) => {
      const value = Object.hasOwn(values, setting.key)
        ? values[setting.key]
        : setting.default;
      let valid = false;
      switch (setting.type) {
        case "boolean":
          valid = typeof value === "boolean";
          break;
        case "text":
          valid = typeof value === "string" && value.length <= 200;
          break;
        case "color":
          valid = typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
          break;
        case "number":
          valid =
            typeof value === "number" &&
            Number.isFinite(value) &&
            value >= setting.min &&
            value <= setting.max;
          break;
        case "select":
          valid =
            typeof value === "string" &&
            setting.options.some((o) => o.value === value);
          break;
      }
      if (!valid) throw new Error(`Invalid value for ${setting.label}.`);
      return [setting.key, value as string | number | boolean];
    }),
  );
}
