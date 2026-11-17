import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Source } from "../../shared/face-data.js";
import {
  ConnectorError,
  type Connector,
  type Reading,
} from "./home-assistant.js";

export const folderSchema = z
  .string()
  .max(200)
  .refine(
    (value) =>
      value === "" ||
      (!path.isAbsolute(value) &&
        value
          .split("/")
          .every(
            (part) =>
              part.length > 0 &&
              part !== "." &&
              part !== ".." &&
              !part.startsWith(".") &&
              !/[\\\p{Cc}]/u.test(part),
          )),
    "Use a relative folder inside the configured photo directory.",
  );
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const extensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const FILE_LIMIT = 50 * 1024 * 1024;
type Photo = { id: string; filename: string };
type Collection = { source: Source; photos: Photo[]; revision: string };

// Folder/file IDs are opaque; filesystem paths never enter display snapshots.
export class MountedFolder implements Connector {
  private collections = new Map<string, Collection>();
  private watchers = new Set<{
    ids: string[];
    callback: (values: Map<string, Reading>) => void;
  }>();
  private scanning?: Promise<void>;
  private closed = false;
  private observedAt = 0;
  private root = "";
  constructor(
    private directory: string,
    private folder: string,
  ) {
    folderSchema.parse(folder);
  }
  async confirm() {
    if (this.scanning) return this.scanning;
    this.scanning = this.scan().finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }
  private async scan() {
    try {
      const root = await realpath(this.directory);
      const selected = path.resolve(root, this.folder);
      await this.checkPath(root, selected);
      if (!(await lstat(selected)).isDirectory()) throw new Error();
      const collections = new Map<string, Collection>();
      let entries = 0;
      const deadline = Date.now() + 10000;
      const visit = async (
        directory: string,
        depth: number,
      ): Promise<Photo[]> => {
        if (depth > 16 || this.closed || Date.now() > deadline)
          throw new ConnectorError(
            "Photo scan limit exceeded. Choose a smaller folder.",
          );
        const photos: Photo[] = [];
        await this.checkPath(root, directory);
        const folderId = hash(`folder:${path.relative(root, directory)}`);
        const versions: string[] = [];
        const stream = await opendir(directory);
        for await (const entry of stream) {
          if (++entries > 10000 || Date.now() > deadline || this.closed)
            throw new ConnectorError(
              "Photo scan limit exceeded. Choose a smaller folder.",
            );
          if (entry.name.startsWith(".") || /[\\\p{Cc}]/u.test(entry.name))
            continue;
          const filename = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            const nested = await visit(filename, depth + 1);
            photos.push(...nested);
            versions.push(
              collections.get(hash(`folder:${path.relative(root, filename)}`))!
                .revision,
            );
          } else if (
            entry.isFile() &&
            extensions.has(path.extname(entry.name).toLowerCase())
          ) {
            const info = await lstat(filename);
            if (!info.isFile() || info.size > FILE_LIMIT) continue;
            const id = hash(`file:${path.relative(root, filename)}`);
            const photo = { id, filename };
            const revision = hash(
              `${id}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
            );
            photos.push(photo);
            versions.push(revision);
            collections.set(id, {
              source: {
                id,
                label: path.relative(selected, filename).slice(0, 200),
                type: "image",
                unit: null,
                available: true,
                kind: "file",
              },
              photos: [photo],
              revision,
            });
          }
        }
        photos.sort((a, b) => a.filename.localeCompare(b.filename, "en"));
        collections.set(folderId, {
          source: {
            id: folderId,
            label:
              `${path.relative(selected, directory) || "All photos"} /`.slice(
                0,
                200,
              ),
            type: "image",
            unit: null,
            available: photos.length > 0,
            kind: "folder",
          },
          photos,
          revision: hash(versions.sort().join(":")),
        });
        return photos;
      };
      await visit(selected, 0);
      if (this.closed) return;
      this.root = root;
      this.collections = collections;
      this.observedAt = Date.now();
      for (const watcher of this.watchers)
        watcher.callback(this.readings(watcher.ids));
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(
        "Cannot read the mounted photo folder. Check the mount, folder, and read permissions.",
      );
    }
  }
  private async checkPath(root: string, filename: string) {
    const relative = path.relative(root, filename);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error();
    let current = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error();
    }
    if ((await realpath(filename)) !== filename) throw new Error();
  }
  async discover() {
    await this.confirm();
    return [...this.collections.values()]
      .map((collection) => collection.source)
      .sort(
        (a, b) =>
          (a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1) ||
          a.label.localeCompare(b.label, "en"),
      );
  }
  private readings(ids: string[]) {
    return new Map(
      ids.flatMap((id): [string, Reading][] => {
        const collection = this.collections.get(id);
        if (!collection) return [];
        return [
          [
            id,
            {
              source: collection.source,
              reading: {
                type: "image",
                status: collection.photos.length ? "ready" : "unavailable",
                value: collection.photos.length
                  ? {
                      count: collection.photos.length,
                      revision: collection.revision,
                      url: null,
                    }
                  : null,
                unit: null,
                updatedAt: this.observedAt,
                observedAt: this.observedAt,
                expiresAt: this.observedAt + 90000,
              },
            },
          ],
        ];
      }),
    );
  }
  watch(ids: string[], callback: (values: Map<string, Reading>) => void) {
    const watcher = { ids, callback };
    this.watchers.add(watcher);
    callback(this.readings(ids));
    return {
      ready: Promise.resolve(),
      close: () => {
        this.watchers.delete(watcher);
      },
    };
  }
  async read(sourceId: string, index: number) {
    const photo = this.collections.get(sourceId)?.photos[index];
    if (!photo || this.closed) throw new Error("Photo unavailable.");
    // Revalidate on every read, including cache hits and after mount changes.
    if ((await realpath(this.directory)) !== this.root) throw new Error();
    await this.checkPath(this.root, photo.filename);
    const handle = await open(
      photo.filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > FILE_LIMIT) throw new Error();
      if (
        process.platform === "linux" &&
        (await realpath(`/proc/self/fd/${handle.fd}`)) !== photo.filename
      )
        throw new Error();
      // Verify the opened inode as well as the path to reject replacement races.
      await this.checkPath(this.root, photo.filename);
      const current = await lstat(photo.filename);
      if (current.ino !== info.ino || current.dev !== info.dev)
        throw new Error();
      return {
        key: `${photo.id}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
        load: async () => {
          const bytes = Buffer.alloc(info.size);
          let offset = 0;
          while (offset < bytes.length) {
            const result = await handle.read(
              bytes,
              offset,
              bytes.length - offset,
              offset,
            );
            if (!result.bytesRead) throw new Error();
            offset += result.bytesRead;
          }
          return bytes;
        },
        close: () => handle.close(),
      };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  close() {
    this.closed = true;
    this.watchers.clear();
    this.collections.clear();
  }
}
