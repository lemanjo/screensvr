import { once } from "node:events";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import sharp from "sharp";

export const immichToken = "fake-immich-api-key-for-tests-only";
export type FakeAsset = {
  id: string;
  type: string;
  visibility: string;
  isTrashed: boolean;
  isOffline: boolean;
  updatedAt: string;
  fileCreatedAt: string;
  checksum: string;
  thumbhash: string | null;
  originalPath: string;
};
type Album = {
  id: string;
  albumName: string;
  assets: string[];
  denied?: boolean;
};
type Search = {
  filter: {
    albumIds: { any: string[] };
    id?: { eq: string };
    type: { eq: string };
    visibility: { in: string[] };
    trashedAt: { eq: null };
  };
  cursor?: string;
  size: number;
};

/** Real HTTP fixture implementing only the required Immich 3.4 read API. */
export class FakeImmich {
  readonly albums = new Map<string, Album>();
  readonly assets = new Map<string, FakeAsset>();
  readonly requests: { method: string; path: string; body?: Search }[] = [];
  readonly family = randomUUID();
  readonly shared = randomUUID();
  readonly empty = randomUUID();
  readonly privateAlbum = randomUUID();
  permissions = ["album.read", "asset.read", "asset.view"];
  token = immichToken;
  version = { major: 3, minor: 4, patch: 1 };
  rejectKey = false;
  status = 0;
  pageSize = 500;
  repeatCursor = false;
  ignoreFilters = false;
  delay = 0;
  redirectPreview = false;
  preview: Buffer = Buffer.alloc(0);
  previewOverride?: Buffer;
  jsonOverride?: string;
  url = "";
  private server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body: Search | undefined = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : undefined;
    this.requests.push({ method: request.method!, path: url.pathname, body });
    if (this.delay)
      await new Promise((resolve) => setTimeout(resolve, this.delay));
    if (response.destroyed) return;
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (this.status)
      return json({ message: "secret upstream diagnostic" }, this.status);
    if (request.headers["x-api-key"] !== this.token || this.rejectKey)
      return json({ message: "secret upstream diagnostic" }, 401);
    if (this.jsonOverride !== undefined) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(this.jsonOverride);
      return;
    }
    if (url.pathname === "/api/server/version") return json(this.version);
    if (url.pathname === "/api/api-keys/me")
      return json({ permissions: this.permissions });
    if (url.pathname === "/api/albums") {
      return json(
        [...this.albums.values()]
          .filter((album) => !album.denied)
          .map(({ id, albumName, assets }) => ({
            id,
            albumName,
            assetCount: assets.length,
          })),
      );
    }
    if (url.pathname.startsWith("/api/albums/")) {
      const album = this.albums.get(url.pathname.split("/").at(-1)!);
      if (!album) return json({}, 404);
      if (album.denied) return json({}, 403);
      return json({
        id: album.id,
        albumName: album.albumName,
        assetCount: album.assets.length,
      });
    }
    if (url.pathname === "/api/search/metadata" && body) {
      if (
        body.filter.type.eq !== "IMAGE" ||
        body.filter.visibility.in.some(
          (value) =>
            !["timeline", "archive", "hidden", "locked"].includes(value),
        )
      )
        return json({}, 400);
      const album = this.albums.get(body.filter.albumIds.any[0]);
      if (!album) return json({}, 404);
      if (album.denied) return json({}, 403);
      const items = album.assets
        .map((id) => this.assets.get(id)!)
        .filter(
          (asset) =>
            asset &&
            (this.ignoreFilters ||
              ((!body.filter.id || asset.id === body.filter.id.eq) &&
                asset.type === body.filter.type.eq &&
                body.filter.visibility.in.includes(asset.visibility) &&
                body.filter.trashedAt.eq === null &&
                !asset.isTrashed)),
        )
        .sort(
          (a, b) =>
            a.fileCreatedAt.localeCompare(b.fileCreatedAt) ||
            a.id.localeCompare(b.id),
        );
      const offset = Number(body.cursor ?? 0);
      const size = Math.min(this.pageSize, body.size);
      return json({
        assets: {
          items: items.slice(offset, offset + size),
          nextCursor: this.repeatCursor
            ? "1"
            : offset + size < items.length
              ? String(offset + size)
              : null,
        },
      });
    }
    if (/\/api\/assets\/[^/]+\/thumbnail$/.test(url.pathname)) {
      if (!this.permissions.includes("asset.view")) return json({}, 403);
      if (this.redirectPreview) {
        response.writeHead(302, { location: "http://169.254.169.254/private" });
        response.end();
        return;
      }
      if (
        url.searchParams.get("size") !== "preview" ||
        url.searchParams.get("edited") !== "true"
      )
        return json({}, 400);
      response.writeHead(200, { "content-type": "image/jpeg" });
      response.end(this.previewOverride ?? this.preview);
      return;
    }
    json({}, 404);
  });
  static async start() {
    const fake = new FakeImmich();
    fake.preview = await sharp({
      create: { width: 800, height: 400, channels: 3, background: "#507850" },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    fake.server.listen(0, "127.0.0.1");
    await once(fake.server, "listening");
    const address = fake.server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture address.");
    fake.url = `http://127.0.0.1:${address.port}`;
    return fake;
  }
  private constructor() {
    const first = this.addAsset();
    const second = this.addAsset();
    this.albums.set(this.family, {
      id: this.family,
      albumName: "Family",
      assets: [first.id, second.id],
    });
    this.albums.set(this.shared, {
      id: this.shared,
      albumName: "Shared holidays",
      assets: [second.id],
    });
    this.albums.set(this.empty, {
      id: this.empty,
      albumName: "Empty",
      assets: [],
    });
    this.albums.set(this.privateAlbum, {
      id: this.privateAlbum,
      albumName: "Private",
      assets: [this.addAsset().id],
      denied: true,
    });
  }
  addAsset(values: Partial<FakeAsset> = {}) {
    const asset: FakeAsset = {
      id: randomUUID(),
      type: "IMAGE",
      visibility: "timeline",
      isTrashed: false,
      isOffline: false,
      updatedAt: "2026-11-01T00:00:00.000Z",
      fileCreatedAt: "2026-01-01T00:00:00.000Z",
      checksum: "a".repeat(28),
      thumbhash: null,
      originalPath: "/private/originals/do-not-expose.heic",
      ...values,
    };
    this.assets.set(asset.id, asset);
    return asset;
  }
  async close() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
