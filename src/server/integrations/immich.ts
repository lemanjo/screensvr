import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { z } from "zod";
import type { Source } from "../../shared/face-data.js";
import {
  ConnectorError,
  type PhotoConnector,
  type Reading,
} from "./connector.js";
import { immichUrl, secureLookup } from "./network.js";

const JSON_LIMIT = 16 * 1024 * 1024;
const PHOTO_LIMIT = 10000;
const permissions = ["album.read", "asset.read", "asset.view"];
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const albumSchema = z.object({
  id: z.string().uuid(),
  albumName: z.string().max(4096),
  assetCount: z.number().int().nonnegative(),
});
const assetSchema = z.object({
  id: z.string().uuid(),
  type: z.string().max(32),
  visibility: z.string().max(32),
  isTrashed: z.boolean(),
  isOffline: z.boolean().optional(),
  updatedAt: z.string().max(80),
  fileCreatedAt: z.string().max(80),
  checksum: z.string().max(128),
  thumbhash: z.string().max(256).nullable(),
});
const searchSchema = z.object({
  assets: z.object({
    items: z.array(assetSchema).max(500),
    nextCursor: z.string().max(4096).nullable(),
  }),
});
type Asset = z.infer<typeof assetSchema>;
type Collection = {
  source: Source;
  photos: Asset[];
  revision: string;
  at: number;
  accessed: number;
};
type Watcher = {
  ids: string[];
  callback: (values: Map<string, Reading>) => void;
  abort: AbortController;
  initialized: boolean;
};
class ResponseError extends ConnectorError {
  constructor(readonly status: number) {
    super(
      status === 401
        ? "Immich rejected the API key."
        : status === 403
          ? "Immich refused access. Check the API key permissions and album access."
          : "Immich returned an unsuccessful read response. Check its connection and API compatibility.",
      status === 401,
    );
  }
}
function decode<T>(bytes: Buffer, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw new ConnectorError(
      "Immich returned an invalid or oversized response.",
    );
  }
}
const playable = (asset: Asset) =>
  asset.type === "IMAGE" &&
  ["timeline", "archive"].includes(asset.visibility) &&
  !asset.isTrashed &&
  !asset.isOffline;
const versionKey = (asset: Asset) =>
  `${asset.id}:${asset.updatedAt}:${asset.checksum}:${asset.thumbhash}`;

/** All upstream IDs and metadata stay here, never in display snapshots. */
export class Immich implements PhotoConnector {
  private abort = new AbortController();
  private agent: http.Agent;
  private url: string;
  private active = 0;
  private connected = false;
  private collections = new Map<string, Collection>();
  private watchers = new Set<Watcher>();
  private pending = new Map<
    string,
    { promise: Promise<Collection>; abort: AbortController }
  >();
  private confirming?: Promise<void>;
  private detach?: () => void;

  static async connect(
    url: string,
    token: string,
    disconnected: (error: ConnectorError) => void,
    signal?: AbortSignal,
  ) {
    const client = new Immich(url, token, disconnected);
    const abort = () => client.close();
    signal?.addEventListener("abort", abort, { once: true });
    client.detach = () => signal?.removeEventListener("abort", abort);
    if (signal?.aborted) abort();
    try {
      const version = decode(
        await client.request("/server/version"),
        z.object({
          major: z.number().int(),
          minor: z.number().int(),
          patch: z.number().int(),
        }),
      );
      if (
        version.major !== 3 ||
        version.minor < 4 ||
        (version.minor === 4 && version.patch < 1)
      )
        throw new ConnectorError(
          "Use Immich 3.4.1 or newer within 3.x. Other major versions are not supported.",
        );
      await client.checkPermissions();
      await client.discover();
      client.connected = true;
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }
  private constructor(
    url: string,
    private token: string,
    private disconnected: (error: ConnectorError) => void,
  ) {
    this.url = `${immichUrl(url)}/api`;
    const Agent = this.url.startsWith("https:") ? https.Agent : http.Agent;
    this.agent = new Agent({
      keepAlive: true,
      maxSockets: 2,
      maxTotalSockets: 2,
    });
  }
  private async request(
    endpoint: string,
    body?: unknown,
    signal?: AbortSignal,
    limit = JSON_LIMIT,
  ): Promise<Buffer> {
    if (this.abort.signal.aborted)
      throw new ConnectorError("Immich read cancelled.");
    if (this.active >= 32)
      throw new ConnectorError(
        "Too many pending Immich reads. Try again shortly.",
      );
    this.active++;
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        const url = new URL(`${this.url}${endpoint}`);
        const send = url.protocol === "https:" ? https.request : http.request;
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const request = send(
          url,
          {
            method: payload === undefined ? "GET" : "POST",
            agent: this.agent,
            lookup: secureLookup,
            rejectUnauthorized: true,
            signal: AbortSignal.any([
              this.abort.signal,
              AbortSignal.timeout(10000),
              ...(signal ? [signal] : []),
            ]),
            headers: {
              "x-api-key": this.token,
              accept:
                limit === JSON_LIMIT
                  ? "application/json"
                  : "image/jpeg,image/webp,image/png",
              ...(payload
                ? {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(payload),
                  }
                : {}),
            },
          },
          (response) => {
            if (response.statusCode !== 200) {
              // Never follow redirects or expose upstream error bodies/headers.
              const error = new ResponseError(response.statusCode ?? 502);
              response.destroy();
              reject(error);
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > limit) {
                request.destroy(
                  new ConnectorError("Immich response exceeds the size limit."),
                );
                return;
              }
              chunks.push(chunk);
            });
            response.once("end", () => resolve(Buffer.concat(chunks)));
            response.once("error", reject);
          },
        );
        request.once("error", reject);
        request.end(payload);
      });
    } catch (error) {
      const failure =
        error instanceof ConnectorError
          ? error
          : new ConnectorError(
              "Cannot read Immich. Check its URL, network, TLS certificate, and response timeout.",
            );
      if (failure.authentication && this.connected) this.disconnected(failure);
      throw failure;
    } finally {
      this.active--;
    }
  }
  private async checkPermissions() {
    const key = decode(
      await this.request("/api-keys/me"),
      z.object({ permissions: z.array(z.string().max(100)).max(1000) }),
    );
    if (
      !key.permissions.includes("all") &&
      permissions.some((permission) => !key.permissions.includes(permission))
    ) {
      const error = new ConnectorError(
        "Immich API key needs album.read, asset.read, and asset.view permissions.",
        true,
      );
      if (this.connected) this.disconnected(error);
      throw error;
    }
  }
  async discover() {
    return decode(
      await this.request("/albums"),
      z.array(albumSchema).max(10000),
    )
      .map((album): Source => ({
        id: album.id,
        label: album.albumName.slice(0, 200),
        type: "image",
        unit: null,
        available: album.assetCount > 0,
        kind: "album",
      }))
      .sort(
        (a, b) =>
          a.label.localeCompare(b.label, "en") || a.id.localeCompare(b.id),
      );
  }
  private search(albumId: string, id?: string, cursor?: string) {
    return {
      filter: {
        albumIds: { any: [albumId] },
        ...(id ? { id: { eq: id } } : {}),
        type: { eq: "IMAGE" },
        // Immich's wire values are lowercase, unlike its IMAGE/VIDEO enum.
        visibility: { in: ["timeline", "archive"] },
        trashedAt: { eq: null },
      },
      size: id ? 1 : 500,
      ...(cursor ? { cursor } : {}),
      orderBy: { field: "fileCreatedAt", direction: "asc" },
      withExif: false,
      withPeople: false,
      withStacked: false,
    };
  }
  private async scan(id: string, signal: AbortSignal): Promise<Collection> {
    const previous = this.collections.get(id);
    const photos: Asset[] = [];
    let source: Source = previous?.source ?? {
      id,
      label: "Unavailable album",
      type: "image",
      unit: null,
      available: false,
      kind: "album",
    };
    try {
      const album = decode(
        await this.request(`/albums/${id}`, undefined, signal),
        albumSchema,
      );
      if (album.id !== id)
        throw new ConnectorError("Immich returned the wrong album.");
      source = { ...source, label: album.albumName.slice(0, 200) };
      let cursor: string | undefined;
      let bytes = 0;
      const cursors = new Set<string>();
      const ids = new Set<string>();
      do {
        const raw = await this.request(
          "/search/metadata",
          this.search(id, undefined, cursor),
          signal,
        );
        bytes += raw.length;
        if (bytes > JSON_LIMIT)
          throw new ConnectorError(
            "Immich album exceeds the 16 MiB metadata limit. Choose a smaller album.",
          );
        const page = decode(raw, searchSchema).assets;
        for (const asset of page.items) {
          if (!playable(asset) || ids.has(asset.id)) continue;
          ids.add(asset.id);
          photos.push(asset);
        }
        if (photos.length > PHOTO_LIMIT || cursors.size >= 20)
          throw new ConnectorError(
            "Immich album exceeds the 10,000 photo/page limit. Choose a smaller album.",
          );
        cursor = page.nextCursor ?? undefined;
        if (cursor) {
          if (cursors.has(cursor))
            throw new ConnectorError(
              "Immich returned a repeated pagination cursor.",
            );
          cursors.add(cursor);
        }
      } while (cursor);
    } catch (error) {
      if (
        !(error instanceof ResponseError) ||
        ![403, 404].includes(error.status)
      )
        throw error;
      photos.length = 0;
    }
    photos.sort(
      (a, b) =>
        a.fileCreatedAt.localeCompare(b.fileCreatedAt) ||
        a.id.localeCompare(b.id),
    );
    const now = Date.now();
    const revision = hash(photos.map(versionKey).join(":"));
    return {
      source: { ...source, available: photos.length > 0 },
      photos,
      revision,
      at: now,
      accessed: now,
    };
  }
  private load(
    id: string,
    refresh = false,
    signal?: AbortSignal,
  ): Promise<Collection> {
    if (!z.string().uuid().safeParse(id).success)
      return Promise.reject(
        new ConnectorError("Invalid Immich album selection."),
      );
    const running = this.pending.get(id);
    if (running && !running.abort.signal.aborted) return running.promise;
    const now = Date.now();
    const selected = new Set(
      [...this.watchers].flatMap((watcher) => watcher.ids),
    );
    for (const [key, value] of this.collections)
      if (!selected.has(key) && now - value.accessed > 10 * 60000)
        this.collections.delete(key);
    const existing = this.collections.get(id);
    if (existing && !refresh && now - existing.at < 30000) {
      existing.accessed = now;
      return Promise.resolve(existing);
    }
    if (!existing && this.collections.size + this.pending.size >= 320)
      return Promise.reject(
        new ConnectorError(
          "Too many Immich album selections. Try again later.",
        ),
      );
    const abort = new AbortController();
    const promise = this.scan(
      id,
      AbortSignal.any([
        abort.signal,
        AbortSignal.timeout(30000),
        ...(signal ? [signal] : []),
      ]),
    )
      .then((collection) => {
        if (abort.signal.aborted || this.abort.signal.aborted)
          throw new ConnectorError("Immich read cancelled.");
        const count = [...this.collections]
          .filter(([key]) => key !== id)
          .reduce(
            (sum, [, value]) => sum + value.photos.length,
            collection.photos.length,
          );
        if (count > PHOTO_LIMIT)
          throw new ConnectorError(
            "Immich selected albums exceed 10,000 indexed photos. Choose fewer or smaller albums.",
          );
        this.collections.set(id, collection);
        this.publish();
        return collection;
      })
      .finally(() => {
        if (this.pending.get(id)?.promise === promise) this.pending.delete(id);
      });
    this.pending.set(id, { promise, abort });
    return promise;
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
                updatedAt: collection.at,
                observedAt: collection.at,
                expiresAt: collection.at + 90000,
              },
            },
          ],
        ];
      }),
    );
  }
  private publish() {
    if (this.abort.signal.aborted) return;
    for (const watcher of this.watchers)
      if (watcher.initialized) watcher.callback(this.readings(watcher.ids));
  }
  watch(ids: string[], callback: (values: Map<string, Reading>) => void) {
    const watcher: Watcher = {
      ids: [...new Set(ids)],
      callback,
      abort: new AbortController(),
      initialized: false,
    };
    this.watchers.add(watcher);
    const ready = (async () => {
      for (const id of watcher.ids) {
        if (watcher.abort.signal.aborted)
          throw new ConnectorError("Immich preview cancelled.");
        await this.load(id);
      }
      if (watcher.abort.signal.aborted || this.abort.signal.aborted)
        throw new ConnectorError("Immich preview cancelled.");
      watcher.initialized = true;
      callback(this.readings(watcher.ids));
    })();
    return {
      ready,
      close: () => {
        this.watchers.delete(watcher);
        watcher.abort.abort();
        for (const [id, pending] of this.pending)
          if (![...this.watchers].some((item) => item.ids.includes(id)))
            pending.abort.abort();
      },
    };
  }
  confirm() {
    if (this.confirming) return this.confirming;
    this.confirming = (async () => {
      const signal = AbortSignal.timeout(30000);
      await this.checkPermissions();
      const ids = new Set([...this.watchers].flatMap((watcher) => watcher.ids));
      for (const id of ids) {
        if (signal.aborted)
          throw new ConnectorError("Immich album refresh timed out.");
        await this.load(id, true, signal);
      }
    })().finally(() => {
      this.confirming = undefined;
    });
    return this.confirming;
  }
  async read(sourceId: string, index: number) {
    const collection = this.collections.get(sourceId);
    const photo = collection?.photos[index];
    if (!photo || this.abort.signal.aborted)
      throw new ConnectorError("Photo unavailable.");
    collection.accessed = Date.now();
    // Recheck upstream authorization AND album membership even on resized-cache hits.
    const current = decode(
      await this.request("/search/metadata", this.search(sourceId, photo.id)),
      searchSchema,
    ).assets.items.find((asset) => asset.id === photo.id && playable(asset));
    if (!current) throw new ConnectorError("Photo unavailable.");
    return {
      key: versionKey(current),
      load: () =>
        this.request(
          `/assets/${current.id}/thumbnail?size=preview&edited=true`,
          undefined,
          undefined,
          50 * 1024 * 1024,
        ),
      close: async () => {},
    };
  }
  close() {
    this.connected = false;
    this.abort.abort();
    this.detach?.();
    for (const watcher of this.watchers) watcher.abort.abort();
    this.watchers.clear();
    this.collections.clear();
    this.agent.destroy();
  }
}
