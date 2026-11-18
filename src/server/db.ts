import { DatabaseSync } from "node:sqlite";
import type { Face, Settings } from "../shared/contracts.js";
import { isCalendarBinding, type Bindings } from "../shared/face-data.js";
import { chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Scene, Schedule } from "../shared/scenes.js";
import { resolveSchedule } from "./scheduler.js";

export type IntegrationRow = {
  id: string;
  type:
    | "home-assistant"
    | "mounted-folder"
    | "immich"
    | "ical"
    | "online-backgrounds";
  name: string;
  base_url: string;
  credentials: string;
  enabled: number;
  revision: number;
};

export type DeviceRow = {
  id: string;
  slug: string;
  name: string;
  manual_scene_id: string;
  schedule_enabled: number;
  timezone: string;
  revision: number;
  last_seen: number | null;
};

export class Store {
  readonly db: DatabaseSync;
  private selections = new Map<
    string,
    {
      revision: number;
      at: number;
      until: number;
      sceneId: string;
      occurrence: string;
      generation: string;
      next: { at: number; sceneId: string } | null;
    }
  >();

  constructor(
    filename: string,
    readonly now: () => number = () => Date.now(),
  ) {
    this.db = new DatabaseSync(filename);
    if (filename !== ":memory:") chmodSync(filename, 0o600);
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    const version = (
      this.db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    if (version > 5) {
      this.db.close();
      throw new Error("This database requires a newer screensvr version.");
    }
    if (version === 0) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE sessions (hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
        CREATE TABLE faces (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, builtin INTEGER NOT NULL);
        CREATE TABLE devices (
          id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
          face_id TEXT NOT NULL REFERENCES faces(id),
          settings TEXT NOT NULL, timezone TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
          last_seen INTEGER
        );
        PRAGMA user_version = 2;
        COMMIT;
      `);
    }
    if (version === 1) {
      this.db.exec("BEGIN;");
      try {
        this.db.exec(
          "ALTER TABLE devices ADD COLUMN slug TEXT NOT NULL DEFAULT '';",
        );
        const rows = this.db
          .prepare("SELECT id, name FROM devices ORDER BY rowid")
          .all() as { id: string; name: string }[];
        for (const row of rows)
          this.db
            .prepare("UPDATE devices SET slug = ? WHERE id = ?")
            .run(this.availableSlug(row.name), row.id);
        this.db.exec(`
          CREATE UNIQUE INDEX devices_slug ON devices(slug);
          ALTER TABLE devices DROP COLUMN token_hash;
          PRAGMA user_version = 2;
          COMMIT;
        `);
      } catch (error) {
        this.db.exec("ROLLBACK;");
        this.db.close();
        throw error;
      }
    }
    if (version < 3) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE integrations (
          id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
          base_url TEXT NOT NULL, credentials TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE device_input_bindings (
          device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
          input_key TEXT NOT NULL,
          integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE RESTRICT,
          source_id TEXT NOT NULL,
          PRIMARY KEY (device_id, input_key)
        );
        CREATE INDEX bindings_integration ON device_input_bindings(integration_id);
        PRAGMA user_version = 3;
        COMMIT;
      `);
    }
    if (version < 4) {
      this.db.exec("BEGIN;");
      try {
        this.db.exec(`
          CREATE TABLE devices_new (
            id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
            timezone TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
            last_seen INTEGER, manual_scene_id TEXT NOT NULL,
            schedule_enabled INTEGER NOT NULL DEFAULT 0 CHECK(schedule_enabled IN (0, 1)),
            FOREIGN KEY (id, manual_scene_id) REFERENCES scenes(device_id, id)
              DEFERRABLE INITIALLY DEFERRED
          );
          CREATE TABLE scenes (
            id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices_new(id) ON DELETE CASCADE,
            name TEXT NOT NULL, face_id TEXT NOT NULL REFERENCES faces(id) ON DELETE RESTRICT,
            settings TEXT NOT NULL, UNIQUE(device_id, id)
          );
          CREATE TABLE scene_input_bindings (
            scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
            input_key TEXT NOT NULL, integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE RESTRICT,
            source_id TEXT NOT NULL, PRIMARY KEY(scene_id, input_key)
          );
          CREATE INDEX scene_bindings_integration ON scene_input_bindings(integration_id);
          CREATE TABLE schedule_entries (
            device_id TEXT NOT NULL REFERENCES devices_new(id) ON DELETE CASCADE,
            weekday INTEGER NOT NULL CHECK(weekday BETWEEN 1 AND 7),
            minute INTEGER NOT NULL CHECK(minute BETWEEN 0 AND 1439),
            scene_id TEXT NOT NULL,
            PRIMARY KEY(device_id, weekday, minute),
            FOREIGN KEY(device_id, scene_id) REFERENCES scenes(device_id, id) ON DELETE RESTRICT
          );
        `);
        const rows = this.db.prepare("SELECT * FROM devices").all() as {
          id: string;
          slug: string;
          name: string;
          timezone: string;
          revision: number;
          last_seen: number | null;
          face_id: string;
          settings: string;
        }[];
        for (const row of rows) {
          const sceneId = randomUUID();
          this.db
            .prepare(
              "INSERT INTO devices_new (id, slug, name, timezone, revision, last_seen, manual_scene_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              row.id,
              row.slug,
              row.name,
              row.timezone,
              row.revision,
              row.last_seen,
              sceneId,
            );
          this.db
            .prepare("INSERT INTO scenes VALUES (?, ?, 'Default', ?, ?)")
            .run(sceneId, row.id, row.face_id, row.settings);
          this.db
            .prepare(
              "INSERT INTO scene_input_bindings SELECT ?, input_key, integration_id, source_id FROM device_input_bindings WHERE device_id = ?",
            )
            .run(sceneId, row.id);
        }
        this.db.exec(`
          DROP TABLE device_input_bindings;
          DROP TABLE devices;
          ALTER TABLE devices_new RENAME TO devices;
          PRAGMA user_version = 4;
          COMMIT;
        `);
      } catch (error) {
        this.db.exec("ROLLBACK;");
        this.db.close();
        throw error;
      }
    }
    if (version < 5) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE scene_calendar_sources (
          scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
          input_key TEXT NOT NULL,
          integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE RESTRICT,
          source_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          show_title INTEGER NOT NULL DEFAULT 0 CHECK(show_title IN (0, 1)),
          PRIMARY KEY(scene_id, input_key, integration_id, source_id)
        );
        CREATE INDEX calendar_sources_integration ON scene_calendar_sources(integration_id);
        PRAGMA user_version = 5;
        COMMIT;
      `);
    }
    // Provision once, including upgrades. The marker preserves explicit opt-outs:
    // disabling or removing the connection must survive future restarts.
    if (!this.getMeta("online-backgrounds-provisioned")) {
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        this.db
          .prepare(
            `INSERT INTO integrations (id, type, name, base_url, credentials, enabled)
             SELECT ?, 'online-backgrounds', 'Online backgrounds', '', '', 1
             WHERE NOT EXISTS (SELECT 1 FROM integrations WHERE type = 'online-backgrounds')`,
          )
          .run(randomUUID());
        this.db
          .prepare(
            "INSERT OR IGNORE INTO meta (key, value) VALUES ('online-backgrounds-provisioned', '1')",
          )
          .run();
        this.db.exec("COMMIT;");
      } catch (error) {
        this.db.exec("ROLLBACK;");
        this.db.close();
        throw error;
      }
    }
  }

  getMeta(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
        { value: string } | undefined
    )?.value;
  }

  integrations() {
    return this.db
      .prepare("SELECT * FROM integrations ORDER BY name COLLATE NOCASE, id")
      .all() as IntegrationRow[];
  }

  integration(id: string) {
    return this.db
      .prepare("SELECT * FROM integrations WHERE id = ?")
      .get(id) as IntegrationRow | undefined;
  }

  bindings(id: string): Bindings {
    const selection = this.selection(id);
    return selection ? this.sceneBindings(selection.sceneId) : {};
  }

  sceneBindings(id: string): Bindings {
    const rows = this.db
      .prepare(
        "SELECT input_key, integration_id, source_id FROM scene_input_bindings WHERE scene_id = ?",
      )
      .all(id) as {
      input_key: string;
      integration_id: string;
      source_id: string;
    }[];
    const bindings: Bindings = Object.fromEntries(
      rows.map((row) => [
        row.input_key,
        { integrationId: row.integration_id, sourceId: row.source_id },
      ]),
    );
    const calendars = this.db
      .prepare(
        "SELECT input_key, integration_id, source_id, show_title FROM scene_calendar_sources WHERE scene_id = ? ORDER BY position",
      )
      .all(id) as {
      input_key: string;
      integration_id: string;
      source_id: string;
      show_title: number;
    }[];
    for (const row of calendars) {
      const binding = bindings[row.input_key] ?? { calendars: [] };
      if (!isCalendarBinding(binding))
        throw new Error("Conflicting input bindings.");
      binding.calendars.push({
        integrationId: row.integration_id,
        sourceId: row.source_id,
        showTitle: Boolean(row.show_title),
      });
      bindings[row.input_key] = binding;
    }
    return bindings;
  }

  replaceBindings(id: string, bindings: Bindings) {
    this.replaceSceneBindings(this.selection(id)!.sceneId, bindings);
  }

  replaceSceneBindings(id: string, bindings: Bindings) {
    this.db
      .prepare("DELETE FROM scene_input_bindings WHERE scene_id = ?")
      .run(id);
    this.db
      .prepare("DELETE FROM scene_calendar_sources WHERE scene_id = ?")
      .run(id);
    const insert = this.db.prepare(
      "INSERT INTO scene_input_bindings VALUES (?, ?, ?, ?)",
    );
    const calendar = this.db.prepare(
      "INSERT INTO scene_calendar_sources VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const [key, binding] of Object.entries(bindings)) {
      if (isCalendarBinding(binding)) {
        binding.calendars.forEach((source, position) =>
          calendar.run(
            id,
            key,
            source.integrationId,
            source.sourceId,
            position,
            Number(source.showTitle),
          ),
        );
      } else insert.run(id, key, binding.integrationId, binding.sourceId);
    }
  }

  usage(id: string) {
    return this.db
      .prepare(
        `SELECT DISTINCT devices.id, devices.name FROM devices JOIN scenes s ON s.device_id = devices.id
         JOIN (SELECT scene_id, integration_id FROM scene_input_bindings UNION SELECT scene_id, integration_id FROM scene_calendar_sources) b
         ON b.scene_id = s.id WHERE b.integration_id = ? ORDER BY devices.name`,
      )
      .all(id) as { id: string; name: string }[];
  }

  faces(): Face[] {
    return (
      this.db
        .prepare(
          "SELECT manifest, builtin FROM faces ORDER BY builtin DESC, id",
        )
        .all() as { manifest: string; builtin: number }[]
    ).map((row) => ({
      manifest: JSON.parse(row.manifest),
      builtin: Boolean(row.builtin),
    }));
  }

  face(id: string): Face | undefined {
    const row = this.db
      .prepare("SELECT manifest, builtin FROM faces WHERE id = ?")
      .get(id) as { manifest: string; builtin: number } | undefined;
    return row
      ? { manifest: JSON.parse(row.manifest), builtin: Boolean(row.builtin) }
      : undefined;
  }

  device(id: string): DeviceRow | undefined {
    return this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as
      DeviceRow | undefined;
  }

  display(identifier: string): DeviceRow | undefined {
    return (
      (this.db
        .prepare("SELECT * FROM devices WHERE slug = ?")
        .get(identifier) as DeviceRow | undefined) ?? this.device(identifier)
    );
  }

  availableSlug(name: string): string {
    const base =
      name
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 80)
        .replace(/^-+|-+$/g, "") || "display";
    let slug = base;
    let suffix = 2;
    while (this.db.prepare("SELECT 1 FROM devices WHERE slug = ?").get(slug))
      slug = `${base}-${suffix++}`;
    return slug;
  }

  devices(): DeviceRow[] {
    return this.db
      .prepare("SELECT * FROM devices ORDER BY name COLLATE NOCASE, id")
      .all() as DeviceRow[];
  }

  createDevice(
    id: string,
    slug: string,
    name: string,
    faceId: string,
    settings: Settings,
    timezone: string,
  ) {
    const sceneId = randomUUID();
    this.db.exec("BEGIN;");
    try {
      this.db
        .prepare(
          "INSERT INTO devices (id, slug, name, timezone, manual_scene_id) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, slug, name, timezone, sceneId);
      this.db
        .prepare("INSERT INTO scenes VALUES (?, ?, 'Default', ?, ?)")
        .run(sceneId, id, faceId, JSON.stringify(settings));
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  scenes(deviceId: string): Scene[] {
    return (
      this.db
        .prepare("SELECT * FROM scenes WHERE device_id = ? ORDER BY rowid")
        .all(deviceId) as {
        id: string;
        name: string;
        face_id: string;
        settings: string;
      }[]
    ).map((row) => ({
      id: row.id,
      name: row.name,
      faceId: row.face_id,
      settings: JSON.parse(row.settings),
      bindings: this.sceneBindings(row.id),
    }));
  }

  scene(deviceId: string, id: string) {
    const row = this.db
      .prepare(
        "SELECT id, name, face_id, settings FROM scenes WHERE device_id = ? AND id = ?",
      )
      .get(deviceId, id) as
      | {
          id: string;
          name: string;
          face_id: string;
          settings: string;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          name: row.name,
          faceId: row.face_id,
          settings: JSON.parse(row.settings) as Settings,
          bindings: this.sceneBindings(row.id),
        }
      : undefined;
  }

  schedule(id: string): Schedule {
    const rows = this.db
      .prepare(
        "SELECT * FROM schedule_entries WHERE device_id = ? ORDER BY minute, weekday",
      )
      .all(id) as {
      weekday: number;
      minute: number;
      scene_id: string;
    }[];
    const entries: Schedule["entries"] = [];
    for (const row of rows) {
      const time = `${String(Math.floor(row.minute / 60)).padStart(2, "0")}:${String(row.minute % 60).padStart(2, "0")}`;
      const existing = entries.find(
        (entry) => entry.time === time && entry.sceneId === row.scene_id,
      );
      if (existing) existing.days.push(row.weekday);
      else entries.push({ days: [row.weekday], time, sceneId: row.scene_id });
    }
    return { enabled: Boolean(this.device(id)?.schedule_enabled), entries };
  }

  replaceSchedule(id: string, schedule: Schedule) {
    this.db.prepare("DELETE FROM schedule_entries WHERE device_id = ?").run(id);
    const insert = this.db.prepare(
      "INSERT INTO schedule_entries VALUES (?, ?, ?, ?)",
    );
    for (const entry of schedule.entries) {
      const [hour, minute] = entry.time.split(":").map(Number);
      for (const day of entry.days)
        insert.run(id, day, hour * 60 + minute, entry.sceneId);
    }
    this.db
      .prepare("UPDATE devices SET schedule_enabled = ? WHERE id = ?")
      .run(Number(schedule.enabled), id);
  }

  selection(id: string, now = this.now()) {
    const device = this.device(id);
    if (!device) {
      this.selections.delete(id);
      return;
    }
    const previous = this.selections.get(id);
    if (
      previous &&
      previous.revision === device.revision &&
      now >= previous.at &&
      now < previous.until
    )
      return previous;
    const resolved = device.schedule_enabled
      ? resolveSchedule(this.schedule(id).entries, device.timezone, now)
      : undefined;
    const sceneId = resolved?.current?.sceneId ?? device.manual_scene_id;
    const occurrence = resolved?.current
      ? String(resolved.current.at)
      : "manual";
    const next = resolved?.next
      ? { at: resolved.next.at, sceneId: resolved.next.sceneId }
      : null;
    const selection = {
      revision: device.revision,
      at: now,
      until: next?.at ?? Infinity,
      sceneId,
      occurrence,
      next,
      generation:
        previous?.sceneId === sceneId && previous.occurrence === occurrence
          ? previous.generation
          : randomUUID(),
    };
    this.selections.set(id, selection);
    return selection;
  }

  activeBindings() {
    return this.devices().map((device) => ({
      id: device.id,
      bindings: this.bindings(device.id),
    }));
  }

  forget(id: string) {
    this.selections.delete(id);
  }

  touch(id: string) {
    this.db
      .prepare("UPDATE devices SET last_seen = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  state(id: string, selection = this.selection(id)) {
    const row = this.device(id);
    if (!row || !selection) return undefined;
    const scene = this.scene(id, selection.sceneId)!;
    const face = this.face(scene.faceId);
    if (!face) throw new Error("Device face is missing.");
    return {
      id: row.id,
      sceneId: scene.id,
      displayUrl: `/display/${row.slug}`,
      name: row.name,
      timezone: row.timezone,
      revision: row.revision,
      face: face.manifest,
      settings: scene.settings,
    };
  }
}
