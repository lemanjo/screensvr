import { DatabaseSync } from "node:sqlite";
import type { Face, Settings } from "../shared/contracts.js";

export type DeviceRow = {
  id: string;
  name: string;
  face_id: string;
  settings: string;
  timezone: string;
  revision: number;
  token_hash: string;
  last_seen: number | null;
};

export class Store {
  readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    const version = (
      this.db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    if (version > 1)
      throw new Error("This database requires a newer screensvr version.");
    if (version === 0) {
      this.db.exec(`
        BEGIN;
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
        COMMIT;
      `);
    }
  }

  getMeta(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
        { value: string } | undefined
    )?.value;
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

  devices(): DeviceRow[] {
    return this.db
      .prepare("SELECT * FROM devices ORDER BY name COLLATE NOCASE, id")
      .all() as DeviceRow[];
  }

  touch(id: string) {
    this.db
      .prepare("UPDATE devices SET last_seen = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  state(id: string) {
    const row = this.device(id);
    if (!row) return undefined;
    const face = this.face(row.face_id);
    if (!face) throw new Error("Device face is missing.");
    return {
      id: row.id,
      name: row.name,
      timezone: row.timezone,
      revision: row.revision,
      face: face.manifest,
      settings: JSON.parse(row.settings) as Settings,
    };
  }
}
