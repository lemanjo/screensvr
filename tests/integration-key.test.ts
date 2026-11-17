import { afterEach, beforeEach, expect, it } from "vitest";
import {
  chmod,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Secrets } from "../src/server/integration-key.js";
import { temporaryDirectory } from "./helpers.js";

let directory: string;
beforeEach(async () => {
  directory = await temporaryDirectory("screensvr-integration-key-");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("creates an exclusive key and reads the same descriptor from position zero", async () => {
  const created = new Secrets(directory, false);
  const encrypted = created.encrypt("test-only-token");
  const file = path.join(directory, "integration-key");
  expect((await readFile(file)).length).toBe(32);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(new Secrets(directory, true).decrypt(encrypted)).toBe(
    "test-only-token",
  );
});

it("refuses symlinks without reading or chmodding their targets", async () => {
  const target = path.join(directory, "unrelated-file");
  const contents = Buffer.alloc(32, 42);
  await writeFile(target, contents, { mode: 0o640 });
  await chmod(target, 0o640);
  await symlink(target, path.join(directory, "integration-key"));
  for (const existing of [false, true]) {
    expect(() =>
      new Secrets(directory, existing).encrypt("test-only-token"),
    ).toThrow("key is missing or invalid");
  }
  expect(await readFile(target)).toEqual(contents);
  expect((await stat(target)).mode & 0o777).toBe(0o640);
});

it("does not replace missing or malformed keys when credentials already exist", async () => {
  const file = path.join(directory, "integration-key");
  expect(() => new Secrets(directory, true).encrypt("test-only-token")).toThrow(
    "key is missing or invalid",
  );
  await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(file, "not-a-valid-key");
  expect(() => new Secrets(directory, true).encrypt("test-only-token")).toThrow(
    "key is missing or invalid",
  );
  expect(await readFile(file, "utf8")).toBe("not-a-valid-key");
});

it("restricts permissions using the already-open valid key", async () => {
  const created = new Secrets(directory, false);
  const encrypted = created.encrypt("test-only-token");
  const file = path.join(directory, "integration-key");
  await chmod(file, 0o644);
  expect(new Secrets(directory, true).decrypt(encrypted)).toBe(
    "test-only-token",
  );
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});
