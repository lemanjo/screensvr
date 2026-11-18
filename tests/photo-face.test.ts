import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import type { PhotoCredit } from "../src/shared/photo-credit.js";

afterEach(() => vi.useRealTimers());
it("changes credits only after loading the matching photo, retains them on errors, and clears revoked selections", () => {
  vi.useFakeTimers();
  type Photo = { url: string; credit?: PhotoCredit };
  const elements = new Map<
    string,
    {
      hidden: boolean;
      textContent: string;
      src?: string;
      href?: string;
      removeAttribute: (attribute: string) => void;
    }
  >();
  for (const id of [
    "photo",
    "placeholder",
    "credit",
    "credit-title",
    "credit-author",
    "credit-source",
    "credit-license",
    "time",
    "date",
    "clock",
    "shade",
  ]) {
    const element = {
      hidden: id === "photo" || id === "credit",
      textContent: "",
      removeAttribute(attribute: string) {
        delete (this as unknown as Record<string, unknown>)[attribute];
      },
    };
    elements.set(id, element);
  }
  const images: { src: string; onload: () => void; onerror: () => void }[] = [];
  let update!: (value: unknown) => void;
  let show!: (photo: Photo | null) => void;
  runInNewContext(
    readFileSync(
      new URL("../faces/builtin-photos/face.js", import.meta.url),
      "utf8",
    ),
    {
      document: {
        getElementById: (id: string) => elements.get(id),
        documentElement: { style: { setProperty() {} } },
      },
      window: {
        screensvr: {
          onUpdate: (callback: typeof update) => {
            update = callback;
          },
          photos: {
            watch: (_key: string, callback: typeof show) => {
              show = callback;
              return () => {};
            },
          },
        },
      },
      Image: class {
        src = "";
        onload = () => {};
        onerror = () => {};
        constructor() {
          images.push(this);
        }
      },
      setTimeout,
      clearTimeout,
      setInterval,
      Intl,
      Date,
    },
  );
  update({
    config: { showClock: false, format: "24", interval: 30, shuffle: false },
    context: { timezone: "UTC", locale: "en" },
    data: { photos: { status: "ready" } },
  });
  const credit: PhotoCredit = {
    title: "<b>A real title</b>",
    attribution: "Photographer",
    source: "Wikimedia Commons",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Landscape.jpg",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  };
  show({ url: "/image-one", credit });
  expect(elements.get("credit")!.hidden).toBe(true);
  images[0].onload();
  expect(elements.get("photo")!.src).toBe("/image-one");
  expect(elements.get("credit-title")!.textContent).toBe("<b>A real title</b>");
  expect(elements.get("credit-source")!.href).toBe(credit.sourceUrl);
  expect(elements.get("credit")!.hidden).toBe(false);
  expect(elements.get("clock")!.hidden).toBe(true);
  show({ url: "/image-two", credit: { ...credit, title: "Next photo" } });
  expect(elements.get("credit-title")!.textContent).toBe(credit.title);
  images[1].onerror();
  expect(elements.get("photo")!.src).toBe("/image-one");
  expect(elements.get("credit-title")!.textContent).toBe(credit.title);
  show({ url: "/local-photo" });
  images[2].onload();
  expect(elements.get("credit")!.hidden).toBe(true);
  expect(elements.get("credit-license")!.href).toBeUndefined();
  show({ url: "/slow-image", credit });
  show(null);
  images[3].onload();
  expect(elements.get("photo")!.hidden).toBe(true);
  expect(elements.get("photo")!.src).toBeUndefined();
  expect(elements.get("credit")!.hidden).toBe(true);
});
