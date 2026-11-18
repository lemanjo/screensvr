import sharp from "sharp";
import {
  OnlineHttpError,
  onlineUrl,
} from "../src/server/integrations/online-http.js";

export function commonsPhoto(id = 1) {
  return {
    pageid: id,
    title: `File:Landscape ${id}.jpg`,
    imageinfo: [
      {
        mime: "image/jpeg",
        width: 2400,
        height: 1600,
        size: 200000,
        thumburl: `https://upload.wikimedia.org/wikipedia/commons/a/ab/landscape-${id}.jpg`,
        thumbwidth: 2400,
        thumbheight: 1600,
        descriptionurl: `https://commons.wikimedia.org/wiki/File:Landscape_${id}.jpg`,
        extmetadata: {
          Artist: {
            value: "<a href='https://example.org'>A. Photographer</a>",
          },
          Credit: { value: "<span>Own work</span>" },
          Attribution: { value: "A. Photographer" },
          LicenseShortName: { value: "CC BY-SA 4.0" },
          LicenseUrl: {
            value: "https://creativecommons.org/licenses/by-sa/4.0",
          },
          Restrictions: { value: "" },
        },
      },
    ],
  };
}
export function nasaPhoto(id = "PIA12345") {
  return {
    data: [
      {
        nasa_id: id,
        title: `A beautiful planet ${id}`,
        media_type: "image",
        description: "A NASA image of our solar system.",
        secondary_creator: "NASA/JPL-Caltech",
        center: "JPL",
      },
    ],
    links: [
      {
        href: `https://images-assets.nasa.gov/image/${id}/${id}~thumb.jpg`,
        render: "image",
      },
    ],
  };
}

export class FakeOnlineBackgrounds {
  requests: { url: URL; kind: string }[] = [];
  commons = [commonsPhoto(1), commonsPhoto(2)];
  nasa = [nasaPhoto()];
  commonsPages?: unknown[];
  commonsOverride?: unknown;
  nasaOverride?: unknown;
  files?: string[];
  failCommons = false;
  failNasa = false;
  retryAfter = 60000;
  image!: Buffer;
  block?: (signal: AbortSignal, url: URL) => Promise<void>;
  static async create() {
    const fake = new FakeOnlineBackgrounds();
    fake.image = await sharp({
      create: { width: 800, height: 400, channels: 3, background: "#507850" },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    return fake;
  }
  get = async (
    address: string,
    signal: AbortSignal,
    kind: "json" | "image" = "json",
  ): Promise<Buffer> => {
    const url = new URL(onlineUrl(address));
    this.requests.push({ url, kind });
    await this.block?.(signal, url);
    if (signal.aborted) throw new OnlineHttpError();
    if (kind === "image") return this.image;
    if (url.hostname === "commons.wikimedia.org") {
      if (this.failCommons) throw new OnlineHttpError(this.retryAfter);
      if (url.searchParams.has("meta"))
        return Buffer.from(
          JSON.stringify({
            query: { general: { sitename: "Wikimedia Commons" } },
          }),
        );
      if (this.commonsOverride !== undefined)
        return Buffer.from(
          typeof this.commonsOverride === "string"
            ? this.commonsOverride
            : JSON.stringify(this.commonsOverride),
        );
      const page = Number(url.searchParams.get("gcmcontinue") ?? 0);
      return Buffer.from(
        JSON.stringify(
          this.commonsPages?.[page] ?? { query: { pages: this.commons } },
        ),
      );
    }
    if (url.hostname === "images-api.nasa.gov") {
      if (this.failNasa) throw new OnlineHttpError(this.retryAfter);
      return Buffer.from(
        typeof this.nasaOverride === "string"
          ? this.nasaOverride
          : JSON.stringify(
              this.nasaOverride ?? { collection: { items: this.nasa } },
            ),
      );
    }
    const id = url.pathname.split("/")[2];
    return Buffer.from(
      JSON.stringify(
        this.files ?? [
          `http://images-assets.nasa.gov/image/${id}/${id}~orig.tif`,
          `http://images-assets.nasa.gov/image/${id}/${id}~large.jpg`,
          `http://images-assets.nasa.gov/image/${id}/${id}~medium.jpg`,
        ],
      ),
    );
  };
}
