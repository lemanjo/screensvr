import { createHash } from "node:crypto";
import { z } from "zod";
import type { PhotoValue, Source } from "../../shared/face-data.js";
import { isPhotoCredit, type PhotoCredit } from "../../shared/photo-credit.js";
import {
  ConnectorError,
  type PhotoConnector,
  type Reading,
} from "./connector.js";
import { OnlineHttp, OnlineHttpError, onlineUrl } from "./online-http.js";

const HOUR = 60 * 60 * 1000;
const REFRESH = 6 * HOUR;
const MAX_AGE = 24 * HOUR;
const PHOTO_LIMIT = 48;
const albums = [
  {
    id: "wikimedia-landscapes",
    label: "Wikimedia · Landscapes",
    category: "landscapes",
  },
  { id: "wikimedia-birds", label: "Wikimedia · Birds", category: "birds" },
  {
    id: "wikimedia-flowers",
    label: "Wikimedia · Flowers",
    category: "flowers",
  },
  {
    id: "wikimedia-architecture",
    label: "Wikimedia · Architecture",
    category: "architecture",
  },
  { id: "nasa-nebulae", label: "NASA · Nebulae", query: "nebula" },
  {
    id: "nasa-earth",
    label: "NASA · Earth from space",
    query: "earth from space",
  },
  {
    id: "nasa-planets",
    label: "NASA · Planets",
    query: "Jupiter",
    extraQueries: ["Saturn", "Mars"],
  },
] as const;
type Album = (typeof albums)[number];
type Photo = { id: string; url: string; credit: PhotoCredit };
type Collection = {
  photos: Photo[];
  revision: string;
  at: number;
  accessed: number;
  nextAttempt: number;
  failures: number;
  failed: boolean;
};
type Watcher = {
  ids: string[];
  callback: (values: Map<string, Reading>) => void;
  closed: boolean;
  initialized: boolean;
};
const field = z.object({ value: z.string().max(20000) });
const commonsItem = z.object({
  pageid: z.number().int().positive(),
  title: z.string().max(1024),
  imageinfo: z
    .array(
      z.object({
        mime: z.string(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        size: z.number().int().nonnegative(),
        url: z.string().max(4096).optional(),
        thumburl: z.string().max(4096),
        thumbwidth: z.number().int().positive(),
        thumbheight: z.number().int().positive(),
        descriptionurl: z.string().max(2048),
        extmetadata: z.record(z.string(), field),
      }),
    )
    .max(1)
    .optional(),
});
const commonsResponse = z.object({
  continue: z.object({ gcmcontinue: z.string().max(2048) }).optional(),
  query: z.object({ pages: z.array(z.unknown()).max(20) }).optional(),
});
const nasaItem = z.object({
  data: z
    .array(
      z.object({
        nasa_id: z.string().max(200),
        title: z.string().max(4096),
        media_type: z.string(),
        description: z.string().max(30000).optional(),
        secondary_creator: z.string().max(4096).optional(),
        center: z.string().max(100).optional(),
      }),
    )
    .max(1),
  links: z
    .array(
      z.object({
        href: z.string().max(4096),
        render: z.string().optional(),
      }),
    )
    .max(10)
    .optional(),
});
const nasaResponse = z.object({
  collection: z.object({ items: z.array(z.unknown()).max(100) }),
});
const commonsImages = new Set(["upload.wikimedia.org", "thumb.wikimedia.org"]);
const nasaAssets = new Set(["images-assets.nasa.gov"]);
const nasaUsage = "https://www.nasa.gov/nasa-brand-center/images-and-media/";
const nasaCredits = new Set([
  "NASA",
  "NASA/JPL",
  "NASA/JPL-Caltech",
  "NASA/JPL-Caltech/SSC",
  "NASA/GSFC",
  "NASA/Goddard",
  "NASA/JSC",
  "NASA/KSC",
  "NASA/MSFC",
  "NASA/Ames/JPL-Caltech",
]);
function nasaAssetUrl(value: string) {
  const url = new URL(value);
  // NASA's own manifests still advertise HTTP; request the same asset via TLS.
  if (url.protocol === "http:" && url.hostname === "images-assets.nasa.gov")
    url.protocol = "https:";
  return onlineUrl(url.href, nasaAssets);
}

/** Metadata contains HTML. Decode to text only; never send upstream markup. */
export function creditText(value: string) {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    copy: "©",
  };
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
      if (!entity.startsWith("#"))
        return entities[entity.toLowerCase()] ?? whole;
      const code =
        entity[1].toLowerCase() === "x"
          ? parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : "";
    })
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function decode<T>(bytes: Buffer, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw new ConnectorError("Online image service returned invalid metadata.");
  }
}
function license(shortName: string, address: string) {
  const match = /^CC (BY|BY-SA) (2\.0|2\.5|3\.0|4\.0)$/.exec(shortName);
  const path = match
    ? `/licenses/${match[1].toLowerCase()}/${match[2]}/`
    : shortName === "CC0"
      ? "/publicdomain/zero/1.0/"
      : shortName === "Public domain"
        ? "/publicdomain/mark/1.0/"
        : null;
  if (!path) return null;
  // Public domain metadata often has no LicenseUrl.
  if (!address && shortName === "Public domain")
    return `https://creativecommons.org${path}`;
  try {
    const url = new URL(address);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.hostname !== "creativecommons.org" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      `${url.pathname.replace(/\/+$/, "")}/` !== path
    )
      return null;
    return `https://creativecommons.org${path}`;
  } catch {
    return null;
  }
}
function source(album: Album): Source {
  return {
    id: album.id,
    label: album.label,
    type: "image",
    kind: "album",
    unit: null,
    available: true,
  };
}

export class OnlineBackgrounds implements PhotoConnector {
  private abort = new AbortController();
  private collections = new Map<string, Collection>();
  private pending = new Map<
    string,
    { promise: Promise<Collection>; abort: AbortController }
  >();
  private watchers = new Set<Watcher>();
  private http = new OnlineHttp();
  private confirming?: Promise<void>;

  async discover() {
    return albums.map(source);
  }
  async test() {
    // Explicit connection tests are the only reads before an album is selected.
    decode(
      await this.http.get(
        "https://commons.wikimedia.org/w/api.php?action=query&meta=siteinfo&siprop=general&format=json",
        this.abort.signal,
      ),
      z.object({
        query: z.object({ general: z.object({ sitename: z.string() }) }),
      }),
    );
    decode(
      await this.http.get(
        "https://images-api.nasa.gov/search?q=nebula&media_type=image&page_size=1",
        this.abort.signal,
      ),
      nasaResponse,
    );
    return { ok: true };
  }
  private async wikimedia(
    album: Album & { category: string },
    signal: AbortSignal,
  ) {
    const photos: Photo[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 4 && photos.length < PHOTO_LIMIT; page++) {
      const url = new URL("https://commons.wikimedia.org/w/api.php");
      url.search = new URLSearchParams({
        action: "query",
        format: "json",
        formatversion: "2",
        generator: "categorymembers",
        gcmtitle: `Category:Featured pictures of ${album.category}`,
        gcmtype: "file",
        gcmlimit: "20",
        prop: "imageinfo",
        iiprop: "url|size|mime|extmetadata",
        iiurlwidth: "2560",
        iiextmetadatafilter:
          "Artist|Credit|Attribution|LicenseShortName|LicenseUrl|Restrictions",
        ...(cursor ? { gcmcontinue: cursor } : {}),
      }).toString();
      const result = decode(
        await this.http.get(url.href, signal),
        commonsResponse,
      );
      // An API error is not a confirmed-empty album.
      if (!result.query)
        throw new ConnectorError("Wikimedia album is unavailable.");
      for (const raw of result.query.pages) {
        const parsed = commonsItem.safeParse(raw);
        if (!parsed.success) continue;
        const item = parsed.data;
        const info = item.imageinfo?.[0];
        if (
          !info ||
          !["image/jpeg", "image/png", "image/webp"].includes(info.mime) ||
          Math.max(info.width, info.height) < 1280 ||
          info.thumbwidth * info.thumbheight > 40000000
        )
          continue;
        const metadata = info.extmetadata;
        const get = (key: string) => creditText(metadata[key]?.value ?? "");
        const name = get("LicenseShortName");
        const licenseUrl = license(name, get("LicenseUrl"));
        if (!licenseUrl || get("Restrictions")) continue;
        const attribution = [
          ...new Set(
            [
              get("Artist"),
              get("Attribution"),
              ...(!["Own work", ""].includes(get("Credit"))
                ? [get("Credit")]
                : []),
            ].filter(Boolean),
          ),
        ].join(" · ");
        if (!attribution || attribution.length > 1000) continue;
        try {
          const imageUrl = onlineUrl(info.thumburl, commonsImages);
          if (
            info.url &&
            new URL(info.url).pathname === new URL(imageUrl).pathname &&
            (info.size > 20 * 1024 * 1024 ||
              info.width * info.height > 40000000)
          )
            continue;
          const credit: PhotoCredit = {
            title: creditText(
              item.title.replace(/^File:/, "").replace(/\.[^.]+$/, ""),
            ),
            attribution,
            source: "Wikimedia Commons",
            sourceUrl: info.descriptionurl,
            license: name,
            licenseUrl,
          };
          if (isPhotoCredit(credit))
            photos.push({ id: String(item.pageid), url: imageUrl, credit });
        } catch {
          // One unsupported or untrusted image cannot poison the album.
        }
        if (photos.length === PHOTO_LIMIT) break;
      }
      cursor = result.continue?.gcmcontinue;
      if (!cursor) break;
      if (cursors.has(cursor))
        throw new ConnectorError("Wikimedia repeated a page cursor.");
      cursors.add(cursor);
    }
    return photos;
  }
  private async nasa(album: Album & { query: string }, signal: AbortSignal) {
    const photos: Photo[] = [];
    const queries = [
      album.query,
      ...("extraQueries" in album ? album.extraQueries : []),
    ];
    const perQuery = Math.floor(PHOTO_LIMIT / queries.length);
    for (const query of queries) {
      const url = new URL("https://images-api.nasa.gov/search");
      url.search = new URLSearchParams({
        q: query,
        media_type: "image",
        page_size: "100",
      }).toString();
      const result = decode(
        await this.http.get(url.href, signal),
        nasaResponse,
      );
      let added = 0;
      for (const raw of result.collection.items) {
        const parsed = nasaItem.safeParse(raw);
        if (!parsed.success) continue;
        const item = parsed.data;
        const data = item.data[0];
        const preview = item.links?.find((link) => link.render === "image");
        if (
          !data ||
          !preview ||
          data.media_type !== "image" ||
          /artist|concept|diagram|chart|illustration|animation|proposed|graph|spectrum|map\b/i.test(
            data.title,
          ) ||
          !/^[a-zA-Z0-9_.-]{1,200}$/.test(data.nasa_id)
        )
          continue;
        const attribution =
          creditText(data.secondary_creator ?? "") ||
          // Historic NASA crew imagery often identifies only its issuing center.
          (data.center === "JSC" &&
          /^(iss\d{3}[e-]|sl[234]-|as\d{2}-|s\d{2,3}[e-])/i.test(data.nasa_id)
            ? "NASA/JSC"
            : "");
        // Do not assume every photograph hosted by NASA is NASA-owned.
        if (
          !nasaCredits.has(attribution) ||
          /©|copyright|all rights reserved/i.test(
            `${creditText(data.description ?? "")} ${attribution}`,
          )
        )
          continue;
        try {
          onlineUrl(preview.href, nasaAssets);
          const credit: PhotoCredit = {
            title: creditText(data.title),
            attribution,
            source: "NASA",
            sourceUrl: `https://images.nasa.gov/details/${encodeURIComponent(data.nasa_id)}`,
            license: "NASA media usage guidelines",
            licenseUrl: nasaUsage,
          };
          if (isPhotoCredit(credit)) {
            photos.push({
              id: data.nasa_id,
              // Resolve the provider's sized-image manifest only on an image read.
              url: `https://images-assets.nasa.gov/image/${encodeURIComponent(data.nasa_id)}/collection.json`,
              credit,
            });
            added++;
          }
        } catch {
          // Skip unexpected hosts and unsupported credit metadata.
        }
        if (added === perQuery) break;
      }
    }
    return photos;
  }
  private load(id: string): Promise<Collection> {
    const album = albums.find((item) => item.id === id);
    if (!album || this.abort.signal.aborted)
      return Promise.reject(
        new ConnectorError("Invalid online album selection."),
      );
    const running = this.pending.get(id);
    if (running && !running.abort.signal.aborted) return running.promise;
    const previous = this.collections.get(id);
    if (previous && Date.now() < previous.nextAttempt) {
      previous.accessed = Date.now();
      return Promise.resolve(previous);
    }
    const abort = new AbortController();
    const signal = AbortSignal.any([
      this.abort.signal,
      abort.signal,
      AbortSignal.timeout(60000),
    ]);
    const promise = (async () => {
      let collection: Collection;
      try {
        const found =
          "category" in album
            ? await this.wikimedia(album, signal)
            : await this.nasa(album, signal);
        const photos = [
          ...new Map(found.map((photo) => [photo.id, photo])).values(),
        ].sort((a, b) => a.id.localeCompare(b.id, "en"));
        const now = Date.now();
        collection = {
          photos,
          revision: createHash("sha256")
            .update(JSON.stringify(photos))
            .digest("hex"),
          at: now,
          accessed: now,
          nextAttempt: now + REFRESH,
          failures: 0,
          failed: false,
        };
      } catch (error) {
        if (this.abort.signal.aborted || abort.signal.aborted)
          throw new ConnectorError("Online album read cancelled.");
        const failures = (previous?.failures ?? 0) + 1;
        const delay = Math.max(
          Math.min(HOUR, 60000 * 2 ** Math.min(failures - 1, 6)),
          error instanceof OnlineHttpError ? error.retryAfter : 60000,
        );
        collection = {
          photos: previous?.photos ?? [],
          revision:
            previous?.revision ?? createHash("sha256").update("").digest("hex"),
          at: previous?.at ?? 0,
          accessed: Date.now(),
          nextAttempt: Date.now() + delay,
          failures,
          failed: true,
        };
      }
      if (this.abort.signal.aborted || abort.signal.aborted)
        throw new ConnectorError("Online album read cancelled.");
      this.collections.set(id, collection);
      return collection;
    })().finally(() => {
      if (this.pending.get(id)?.promise === promise) this.pending.delete(id);
    });
    this.pending.set(id, { promise, abort });
    return promise;
  }
  private readings(ids: string[]) {
    return new Map(
      ids.flatMap((id): [string, Reading][] => {
        const album = albums.find((item) => item.id === id);
        const collection = this.collections.get(id);
        if (!album || !collection) return [];
        const available =
          collection.photos.length > 0 && Date.now() - collection.at < MAX_AGE;
        const value: PhotoValue | null = available
          ? {
              count: collection.photos.length,
              revision: collection.revision,
              url: null,
              credits: collection.photos.map((photo) => photo.credit),
            }
          : null;
        return [
          [
            id,
            {
              source: { ...source(album), available },
              validUntil: collection.at + MAX_AGE,
              reading: {
                type: "image",
                status: available
                  ? collection.failed
                    ? "stale"
                    : "ready"
                  : "unavailable",
                value,
                unit: null,
                updatedAt: collection.at || null,
                observedAt: Date.now(),
                expiresAt: Math.min(
                  Date.now() + 90000,
                  collection.at + MAX_AGE,
                ),
              },
            },
          ],
        ];
      }),
    );
  }
  private publish() {
    for (const watcher of this.watchers)
      if (!watcher.closed && watcher.initialized)
        watcher.callback(this.readings(watcher.ids));
  }
  watch(ids: string[], callback: (values: Map<string, Reading>) => void) {
    const watcher: Watcher = {
      ids: [...new Set(ids)],
      callback,
      closed: false,
      initialized: false,
    };
    this.watchers.add(watcher);
    const ready = (async () => {
      for (const id of watcher.ids) {
        if (watcher.closed)
          throw new ConnectorError("Online preview cancelled.");
        await this.load(id);
      }
      if (watcher.closed || this.abort.signal.aborted)
        throw new ConnectorError("Online preview cancelled.");
      watcher.initialized = true;
      callback(this.readings(watcher.ids));
    })();
    return {
      ready,
      close: () => {
        watcher.closed = true;
        this.watchers.delete(watcher);
        for (const [id, pending] of this.pending)
          if (![...this.watchers].some((item) => item.ids.includes(id)))
            pending.abort.abort();
      },
    };
  }
  confirm() {
    if (this.confirming) return this.confirming;
    this.confirming = (async () => {
      const ids = new Set([...this.watchers].flatMap((watcher) => watcher.ids));
      for (const [id, collection] of this.collections)
        if (!ids.has(id) && Date.now() - collection.accessed > 10 * 60000)
          this.collections.delete(id);
      for (const id of ids) {
        try {
          await this.load(id);
        } catch (error) {
          // Removing a selection may cancel its pending refresh; do not
          // disconnect the remaining albums on this connection.
          if (
            this.abort.signal.aborted ||
            [...this.watchers].some((watcher) => watcher.ids.includes(id))
          )
            throw error;
        }
      }
      this.publish();
    })().finally(() => {
      this.confirming = undefined;
    });
    return this.confirming;
  }
  async read(id: string, index: number, revision?: string) {
    const collection = this.collections.get(id);
    const photo = collection?.photos[index];
    if (
      !collection ||
      !photo ||
      this.abort.signal.aborted ||
      !Number.isInteger(index) ||
      Date.now() - collection.at >= MAX_AGE ||
      (revision !== undefined && revision !== collection.revision)
    )
      throw new ConnectorError("Photo unavailable.");
    collection.accessed = Date.now();
    return {
      key: `${collection.revision}:${photo.id}`,
      load: async () => {
        let url = photo.url;
        if (id.startsWith("nasa-")) {
          const files = decode(
            await this.http.get(url, this.abort.signal),
            z.array(z.string().max(4096)).max(100),
          );
          url = ["large", "medium", "small", "orig"]
            .flatMap((size) =>
              files.filter((file) =>
                new RegExp(`~${size}\\.(jpg|jpeg|png|webp)$`, "i").test(file),
              ),
            )
            .flatMap((file) => {
              try {
                const address = nasaAssetUrl(file);
                return new URL(address).pathname.startsWith(
                  `/image/${encodeURIComponent(photo.id)}/`,
                )
                  ? [address]
                  : [];
              } catch {
                return [];
              }
            })[0];
          if (!url)
            throw new ConnectorError("NASA image has no supported size.");
        }
        return this.http.get(url, this.abort.signal, "image");
      },
      close: async () => {},
    };
  }
  close() {
    this.abort.abort();
    for (const pending of this.pending.values()) pending.abort.abort();
    this.watchers.clear();
    this.collections.clear();
    this.http.close();
  }
}
