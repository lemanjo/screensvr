import { test, expect, type Page } from "@playwright/test";
import manifest from "../faces/builtin-stillroom/manifest.json" with { type: "json" };
import type { Settings } from "../src/shared/contracts.js";
import type { FaceData } from "../src/shared/face-data.js";

const defaults = Object.fromEntries(
  manifest.settings.map((setting) => [setting.key, setting.default]),
);
const fixedTime = Date.parse("2026-11-17T21:08:00Z");
function reading(
  status: "ready" | "stale" = "ready",
  value = 21.4,
  unit = "°C",
): FaceData {
  return {
    roomTemperature: {
      type: "number",
      quantity: "temperature",
      status,
      value,
      unit,
      updatedAt: fixedTime,
      observedAt: fixedTime,
      expiresAt: fixedTime + 90000,
    },
  };
}

async function connect(
  page: Page,
  config: Settings = defaults,
  data: FaceData = {},
  timezone = "UTC",
  locale = "en-GB",
) {
  await page.evaluate(
    ({ config, data, timezone, locale }) =>
      new Promise<void>((resolve) => {
        const host = window as typeof window & { stillroomPort?: MessagePort };
        host.stillroomPort?.close();
        const channel = new MessageChannel();
        host.stillroomPort = channel.port1;
        channel.port1.onmessage = ({ data: message }) => {
          if (message.type === "ready")
            channel.port1.postMessage({
              type: "update",
              config,
              data,
              context: { timezone, locale, name: "Living room" },
            });
          if (message.type === "applied") resolve();
        };
        document
          .querySelector("iframe")!
          .contentWindow!.postMessage(
            { type: "screensvr:connect", protocols: [2, 1] },
            "*",
            [channel.port2],
          );
      }),
    { config, data, timezone, locale },
  );
}
async function open(page: Page) {
  await page.clock.setFixedTime(new Date(fixedTime));
  await page.route("**/stillroom-preview", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
      <style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block;overflow:hidden}</style>
      </head><body><iframe title="Stillroom face" sandbox="allow-scripts"
      src="/faces/builtin-stillroom/1.0.0/index.html"></iframe></body></html>`,
    }),
  );
  await page.goto("/stillroom-preview");
  return page.frameLocator('iframe[title="Stillroom face"]');
}

test("Stillroom renders a local serif clock and SDK temperature with calm, honest fallbacks", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  await page.setViewportSize({ width: 1280, height: 800 });
  const face = await open(page);
  await connect(page, defaults, reading());
  await expect(face.locator("#clock")).toHaveAttribute(
    "aria-label",
    "Current time: 21:08",
  );
  await expect(face.locator("#temperature-value")).toHaveText("21.4");
  await expect(face.locator("#temperature-unit")).toHaveText("°C");
  await expect(face.locator("#temperature-status")).toHaveText("");
  await expect(face.locator("body")).toHaveCSS(
    "background-color",
    "rgb(16, 22, 21)",
  );
  await expect(face.locator("#clock")).toHaveCSS(
    "font-family",
    /Instrument Serif/,
  );
  const frame = page
    .frames()
    .find((frame) => frame.url().includes("/faces/builtin-stillroom/"))!;
  expect(
    await frame.evaluate(async () => {
      const fonts = await document.fonts.load('400 32px "Instrument Serif"');
      return fonts.some((font) => font.status === "loaded");
    }),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("stillroom-landscape.png"),
  });

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 320, height: 180 },
  ]) {
    await page.setViewportSize(viewport);
    for (const selector of ["#clock", "#room"]) {
      const bounds = (await face.locator(selector).boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    }
    if (viewport.width === 390)
      await page.screenshot({
        path: testInfo.outputPath("stillroom-portrait.png"),
      });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await connect(
    page,
    {
      ...defaults,
      format: "12",
      showDate: false,
      roomLabel: "Bedroom",
      motion: false,
    },
    reading("ready", 0, "°F"),
    "America/New_York",
  );
  await expect(face.locator("#clock")).toHaveAttribute(
    "aria-label",
    "Current time: 04:08 pm",
  );
  await expect(face.locator("#date")).toBeHidden();
  await expect(face.locator("#room-label")).toHaveText("Bedroom");
  await expect(face.locator("#temperature-value")).toHaveText("0.0");
  await expect(face.locator("#temperature-unit")).toHaveText("°F");
  await expect(face.locator(".atmosphere")).toHaveCSS("animation-name", "none");
  await connect(page, defaults, reading("stale"));
  await expect(face.locator("#room")).toHaveAttribute("data-status", "stale");
  await expect(face.locator("#temperature-status")).toHaveText(
    "Last reading · stale",
  );
  await expect(face.locator("#temperature-value")).toHaveText("21.4");
  for (const status of ["unbound", "loading", "unavailable"] as const) {
    await connect(page, defaults, {
      roomTemperature: {
        type: "number",
        quantity: "temperature",
        status,
        value: null,
        unit: null,
        updatedAt: null,
        observedAt: null,
        expiresAt: null,
      },
    });
    await expect(face.locator("#temperature-value")).toHaveText("—");
    await expect(face.locator("#temperature-unit")).toHaveText("");
    await expect(face.locator("#room")).toHaveAttribute("data-status", status);
  }
  await connect(
    page,
    { ...defaults, roomLabel: "<img src=x onerror=alert(1)>" },
    reading("ready", -3.2),
    "UTC",
    "de-DE",
  );
  await expect(face.locator("#temperature-value")).toHaveText("-3,2");
  await expect(face.locator("#room-label")).toHaveText(
    "<img src=x onerror=alert(1)>",
  );
  await expect(face.locator("#room-label img")).toHaveCount(0);
  await page.clock.setFixedTime(new Date("2026-11-18T00:00:00Z"));
  await connect(page);
  await expect(face.locator("#clock")).toHaveAttribute(
    "aria-label",
    "Current time: 00:00",
  );
  expect(
    requests.every((url) => new URL(url).origin === new URL(page.url()).origin),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("Stillroom respects reduced motion without hiding the clock or temperature", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const face = await open(page);
  await connect(page, defaults, reading());
  await expect(face.locator(".atmosphere")).toHaveCSS("animation-name", "none");
  await expect(face.locator("#clock")).toBeVisible();
  await expect(face.locator("#temperature-value")).toHaveText("21.4");
});
