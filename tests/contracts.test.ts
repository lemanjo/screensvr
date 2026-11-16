import { describe, expect, it } from "vitest";
import { manifestSchema, validateSettings } from "../src/shared/contracts.js";
import { testManifest } from "./helpers.js";

describe("face contracts", () => {
  it("supplies defaults and validates typed settings", () => {
    expect(validateSettings(testManifest, {})).toEqual({
      caption: "Hello, quiet world.",
      size: 24,
    });
    expect(validateSettings(testManifest, { size: 30 }).size).toBe(30);
    for (const values of [
      { size: 100 },
      { size: "24" },
      { size: NaN },
      { extra: true },
      [],
      null,
      { caption: "x".repeat(201) },
    ]) {
      expect(() => validateSettings(testManifest, values)).toThrow();
    }
  });
  it("rejects incompatible manifests, duplicate settings, and invalid defaults", () => {
    for (const manifest of [
      { ...testManifest, schemaVersion: 2 },
      { ...testManifest, id: "../escape" },
      { ...testManifest, entry: "../index.html" },
      {
        ...testManifest,
        settings: [...testManifest.settings, testManifest.settings[0]],
      },
      {
        ...testManifest,
        settings: [{ ...testManifest.settings[1], default: 100 }],
      },
      {
        ...testManifest,
        settings: [
          { key: "constructor", label: "Bad", type: "text", default: "" },
        ],
      },
    ])
      expect(manifestSchema.safeParse(manifest).success).toBe(false);
  });
});
