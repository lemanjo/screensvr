import { createWriteStream, existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { crc32 } from "node:zlib";
import yauzl from "yauzl";
import { manifestSchema } from "../shared/contracts.js";
import type { Store } from "./db.js";

export class UserError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export const ZIP_LIMIT = 10 * 1024 * 1024;
const EXPANDED_LIMIT = 50 * 1024 * 1024;

export class Faces {
  constructor(
    private store: Store,
    readonly directory: string,
    readonly builtinDirectory: string,
  ) {
    for (const id of ["builtin-digital", "builtin-analog"]) {
      const manifest = manifestSchema.parse(
        JSON.parse(
          readFileSync(
            path.join(builtinDirectory, id, "manifest.json"),
            "utf8",
          ),
        ),
      );
      const existing = store.face(id);
      if (existing && !existing.builtin)
        throw new Error(`Reserved face ID: ${id}`);
      store.db
        .prepare(
          "INSERT INTO faces VALUES (?, ?, 1) ON CONFLICT(id) DO UPDATE SET manifest = excluded.manifest",
        )
        .run(id, JSON.stringify(manifest));
    }
  }

  root(id: string, version: string) {
    const face = this.store.face(id);
    if (!face || face.manifest.version !== version) return undefined;
    return face.builtin
      ? path.join(this.builtinDirectory, id)
      : path.join(this.directory, id, version);
  }

  async install(buffer: Buffer) {
    if (buffer.length > ZIP_LIMIT)
      throw new UserError("ZIP packages must be 10 MiB or smaller.", 413);
    await mkdir(this.directory, { recursive: true });
    const staging = await mkdtemp(path.join(this.directory, ".staging-"));
    let destination: string | undefined;
    let reserved = false;
    try {
      await extract(buffer, staging);
      const manifestPath = path.join(staging, "manifest.json");
      if (!existsSync(manifestPath) || (await stat(manifestPath)).size > 65536)
        throw new UserError(
          "A manifest.json of at most 64 KiB is required at the ZIP root.",
        );
      const result = manifestSchema.safeParse(
        JSON.parse(await readFile(manifestPath, "utf8")),
      );
      if (!result.success)
        throw new UserError(
          `Invalid face manifest: ${result.error.issues.map((i) => i.message).join(" ")}`,
        );
      const manifest = result.data;
      if (manifest.id.startsWith("builtin-"))
        throw new UserError("The builtin- prefix is reserved.");
      if (!(await stat(path.join(staging, manifest.entry))).isFile())
        throw new UserError("The package requires an index.html file.");
      if (this.store.face(manifest.id))
        throw new UserError(
          "This face ID is already installed. Remove it before installing another version.",
          409,
        );
      destination = path.join(this.directory, manifest.id, manifest.version);
      await mkdir(path.dirname(destination), { recursive: true });
      // Never overwrite an existing directory, including an orphan from a previous failure.
      await mkdir(destination);
      reserved = true;
      await rename(staging, path.join(destination, "content"));
      // The reserved directory makes installation concurrent-safe. Assets live below content/.
      this.store.db
        .prepare("INSERT INTO faces VALUES (?, ?, 0)")
        .run(manifest.id, JSON.stringify(manifest));
      return { manifest, builtin: false };
    } catch (error) {
      if (reserved && destination)
        await rm(destination, { recursive: true, force: true });
      if (error instanceof UserError) throw error;
      throw new UserError(
        "Invalid ZIP package. Check its structure, manifest, and file sizes.",
      );
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  remove(id: string) {
    const face = this.store.face(id);
    if (!face) throw new UserError("Face not found.", 404);
    if (face.builtin)
      throw new UserError("Bundled faces cannot be removed.", 409);
    if (
      this.store.db.prepare("SELECT id FROM devices WHERE face_id = ?").get(id)
    )
      throw new UserError(
        "Switch all displays away from this face before removing it.",
        409,
      );
    rmSync(path.join(this.directory, id, face.manifest.version), {
      recursive: true,
      force: true,
    });
    this.store.db.prepare("DELETE FROM faces WHERE id = ?").run(id);
  }
}

async function extract(buffer: Buffer, directory: string) {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, file) => (error ? reject(error) : resolve(file!)),
    ),
  );
  await new Promise<void>((resolve, reject) => {
    let count = 0;
    let declared = 0;
    let actual = 0;
    let failed = false;
    const names = new Set<string>();
    const fail = (error: unknown) => {
      if (failed) return;
      failed = true;
      zip.close();
      reject(error);
    };
    zip.on("error", fail);
    zip.on("end", resolve);
    zip.on("entry", (entry: yauzl.Entry) => {
      void (async () => {
        const name = entry.fileName;
        const parts = name.replace(/\/$/, "").split("/");
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (
          ++count > 250 ||
          name.length > 240 ||
          parts.some(
            (p) =>
              !p ||
              p === "." ||
              p === ".." ||
              p.includes(":") ||
              p.includes("\\") ||
              [...p].some((c) => c.charCodeAt(0) < 32),
          ) ||
          name.startsWith("/") ||
          (mode !== 0 && mode !== 0o100000 && mode !== 0o040000) ||
          Boolean(entry.generalPurposeBitFlag & 1) ||
          ![0, 8].includes(entry.compressionMethod)
        ) {
          throw new UserError("Unsafe or unsupported ZIP entry.");
        }
        const canonical = parts.join("/").toLowerCase();
        if (names.has(canonical))
          throw new UserError("Duplicate ZIP paths are not allowed.");
        names.add(canonical);
        declared += entry.uncompressedSize;
        if (entry.uncompressedSize > ZIP_LIMIT || declared > EXPANDED_LIMIT)
          throw new UserError("Expanded ZIP exceeds the file size limits.");
        const target = path.join(directory, ...parts);
        if (name.endsWith("/")) {
          await mkdir(target, { recursive: true });
        } else {
          await mkdir(path.dirname(target), { recursive: true });
          const stream = await new Promise<Readable>((res, rej) =>
            zip.openReadStream(entry, (error, value) =>
              error ? rej(error) : res(value!),
            ),
          );
          let fileBytes = 0;
          let checksum = 0;
          const limit = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              actual += chunk.length;
              fileBytes += chunk.length;
              checksum = crc32(chunk, checksum);
              if (actual > EXPANDED_LIMIT || fileBytes > ZIP_LIMIT)
                callback(
                  new UserError("Expanded ZIP exceeds the file size limits."),
                );
              else callback(null, chunk);
            },
          });
          await pipeline(
            stream,
            limit,
            createWriteStream(target, { flags: "wx" }),
          );
          if (checksum !== entry.crc32)
            throw new UserError("ZIP file checksum failed.");
        }
        if (!failed) zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}

export function faceAssetRoot(faces: Faces, id: string, version: string) {
  const root = faces.root(id, version);
  return (
    root && (id.startsWith("builtin-") ? root : path.join(root, "content"))
  );
}
