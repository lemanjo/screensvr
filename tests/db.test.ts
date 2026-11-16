import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Store } from "../src/server/db.js";
import { temporaryDirectory, testManifest } from "./helpers.js";

let store: Store | undefined;
let directory: string;
afterEach(async () => {
  store?.db.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("migrates existing displays to persistent name-based URLs without losing settings", async () => {
  directory = await temporaryDirectory("screensvr-migration-");
  const filename = path.join(directory, "screensvr.sqlite");
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sessions (hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE faces (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, builtin INTEGER NOT NULL);
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      face_id TEXT NOT NULL REFERENCES faces(id),
      settings TEXT NOT NULL, timezone TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      token_hash TEXT NOT NULL, last_seen INTEGER
    );
    PRAGMA user_version = 1;
  `);
  legacy
    .prepare("INSERT INTO faces VALUES (?, ?, ?)")
    .run(testManifest.id, JSON.stringify(testManifest), 0);
  legacy.prepare("INSERT INTO meta VALUES ('password', 'existing-hash')").run();
  legacy
    .prepare(
      "INSERT INTO sessions VALUES ('existing-session', 'csrf', 9999999999999)",
    )
    .run();
  for (const [id, name] of [
    ["old-one", "Olohuone"],
    ["old-two", "Olohuone!"],
    ["old-three", "Keittiö"],
  ])
    legacy
      .prepare("INSERT INTO devices VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        id,
        name,
        testManifest.id,
        '{"caption":"Saved"}',
        "UTC",
        7,
        "old-token",
        123,
      );
  legacy.close();

  store = new Store(filename);
  expect(store.db.prepare("PRAGMA user_version").get()).toMatchObject({
    user_version: 2,
  });
  expect(store.display("olohuone")).toMatchObject({
    id: "old-one",
    slug: "olohuone",
    revision: 7,
    settings: '{"caption":"Saved"}',
    last_seen: 123,
  });
  expect(store.display("olohuone-2")?.id).toBe("old-two");
  expect(store.display("keittio")?.id).toBe("old-three");
  expect(store.display("old-one")?.slug).toBe("olohuone");
  expect(store.getMeta("password")).toBe("existing-hash");
  expect(store.db.prepare("SELECT * FROM sessions").all()).toHaveLength(1);
  expect(store.device("old-one")).not.toHaveProperty("token_hash");
  expect(() =>
    store!.db
      .prepare("UPDATE devices SET slug = 'olohuone' WHERE id = 'old-two'")
      .run(),
  ).toThrow();

  store.db
    .prepare("UPDATE devices SET name = 'Renamed' WHERE id = 'old-one'")
    .run();
  store.db.close();
  store = new Store(filename);
  expect(store.state("old-one")).toMatchObject({
    displayUrl: "/display/olohuone",
    name: "Renamed",
    settings: { caption: "Saved" },
  });
});
