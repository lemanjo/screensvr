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
    user_version: 4,
  });
  expect(store.display("olohuone")).toMatchObject({
    id: "old-one",
    slug: "olohuone",
    revision: 7,
    last_seen: 123,
  });
  expect(store.scenes("old-one")[0]).toMatchObject({
    name: "Default",
    settings: { caption: "Saved" },
    faceId: testManifest.id,
  });
  expect(store.schedule("old-one")).toEqual({ enabled: false, entries: [] });
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

it("upgrades a v2 database and enforces binding cascade/restrict constraints", async () => {
  directory = await temporaryDirectory("screensvr-v2-migration-");
  const filename = path.join(directory, "screensvr.sqlite");
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sessions (hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE faces (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, builtin INTEGER NOT NULL);
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      face_id TEXT NOT NULL REFERENCES faces(id), settings TEXT NOT NULL,
      timezone TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, last_seen INTEGER
    );
    PRAGMA user_version = 2;
  `);
  legacy
    .prepare("INSERT INTO faces VALUES (?, ?, 0)")
    .run(testManifest.id, JSON.stringify(testManifest));
  legacy
    .prepare(
      "INSERT INTO devices (id, slug, name, face_id, settings, timezone) VALUES ('room', 'room', 'Room', ?, '{}', 'UTC')",
    )
    .run(testManifest.id);
  legacy.close();
  store = new Store(filename);
  expect(store.db.prepare("PRAGMA user_version").get()).toMatchObject({
    user_version: 4,
  });
  expect(store.device("room")?.name).toBe("Room");
  store.db
    .prepare(
      "INSERT INTO integrations (id, type, name, base_url, credentials) VALUES ('home', 'home-assistant', 'Home', 'http://localhost', 'encrypted')",
    )
    .run();
  store.replaceBindings("room", {
    temperature: { integrationId: "home", sourceId: "sensor.room" },
  });
  expect(() =>
    store!.db.prepare("DELETE FROM integrations WHERE id = 'home'").run(),
  ).toThrow();
  store.db.prepare("DELETE FROM devices WHERE id = 'room'").run();
  expect(store.usage("home")).toEqual([]);
  expect(() =>
    store!.db.prepare("DELETE FROM integrations WHERE id = 'home'").run(),
  ).not.toThrow();
});

it("migrates v3 bindings and metadata into a default scene without changing display configuration", async () => {
  directory = await temporaryDirectory("screensvr-v3-scenes-");
  const filename = path.join(directory, "screensvr.sqlite");
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sessions (hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE faces (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, builtin INTEGER NOT NULL);
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      face_id TEXT NOT NULL REFERENCES faces(id), settings TEXT NOT NULL,
      timezone TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, last_seen INTEGER
    );
    CREATE TABLE integrations (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, base_url TEXT NOT NULL,
      credentials TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE device_input_bindings (
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, input_key TEXT NOT NULL,
      integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE RESTRICT,
      source_id TEXT NOT NULL, PRIMARY KEY(device_id, input_key)
    );
    PRAGMA user_version = 3;
  `);
  legacy
    .prepare("INSERT INTO faces VALUES (?, ?, 0)")
    .run(testManifest.id, JSON.stringify(testManifest));
  legacy
    .prepare(
      "INSERT INTO devices VALUES ('room', 'permanent-link', 'Renamed', ?, '{\"caption\":\"Kept\"}', 'Europe/Helsinki', 12, 456)",
    )
    .run(testManifest.id);
  legacy.exec(`
    INSERT INTO integrations VALUES ('home', 'home-assistant', 'Home', 'http://home', 'encrypted-secret', 0, 3);
    INSERT INTO device_input_bindings VALUES ('room', 'temperature', 'home', 'sensor.room');
    INSERT INTO meta VALUES ('password', 'saved-hash');
    INSERT INTO sessions VALUES ('saved-session', 'csrf', 9999999999999);
  `);
  legacy.close();
  store = new Store(filename);
  const scene = store.scenes("room")[0];
  expect(scene).toMatchObject({
    name: "Default",
    faceId: testManifest.id,
    settings: { caption: "Kept" },
    bindings: {
      temperature: { integrationId: "home", sourceId: "sensor.room" },
    },
  });
  expect(store.state("room")).toMatchObject({
    sceneId: scene.id,
    displayUrl: "/display/permanent-link",
    name: "Renamed",
    timezone: "Europe/Helsinki",
    revision: 12,
  });
  expect(store.device("room")?.last_seen).toBe(456);
  expect(store.schedule("room")).toEqual({ enabled: false, entries: [] });
  expect(store.integration("home")).toMatchObject({
    credentials: "encrypted-secret",
    enabled: 0,
    revision: 3,
  });
  expect(store.getMeta("password")).toBe("saved-hash");
  expect(store.db.prepare("SELECT * FROM sessions").all()).toHaveLength(1);
  expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  store.db.close();
  store = new Store(filename);
  expect(store.scenes("room")[0].id).toBe(scene.id);
});
