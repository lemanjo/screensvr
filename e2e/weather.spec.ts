import { expect, test, type Page } from "@playwright/test";
import manifest from "../faces/builtin-weather/manifest.json" with { type: "json" };
import type { FaceData } from "../src/shared/face-data.js";
import type { Settings } from "../src/shared/contracts.js";
import type { WeatherCondition } from "../src/shared/weather.js";
import { FakeHomeAssistant, fakeToken } from "../tests/fake-home-assistant.js";
import { createApp } from "../src/server/app.js";
import { temporaryDirectory } from "../tests/helpers.js";
import { rm } from "node:fs/promises";

const defaults = Object.fromEntries(
  manifest.settings.map((setting) => [setting.key, setting.default]),
);
const now = Date.parse("2026-11-17T12:08:00Z");
function weatherData(
  condition: WeatherCondition = "rain",
  stale = false,
): FaceData {
  const datum = {
    status: stale ? ("stale" as const) : ("ready" as const),
    unit: "°C",
    updatedAt: null,
    observedAt: now,
    expiresAt: now + 90000,
  };
  return {
    weather: {
      ...datum,
      type: "weather",
      value: { temperature: condition === "snow" ? -2 : 12.5, condition },
    },
    daily: {
      ...datum,
      type: "forecast",
      period: "daily",
      value: {
        entries: Array.from({ length: 4 }, (_, index) => ({
          at: Date.parse("2026-11-17T00:00:00Z") + index * 86400000,
          condition,
          temperature: 15 + index,
          low: 7,
        })),
      },
    },
    hourly: {
      ...datum,
      type: "forecast",
      period: "hourly",
      value: {
        entries: Array.from({ length: 10 }, (_, index) => ({
          at: Date.parse("2026-11-17T12:00:00Z") + index * 3600000,
          condition,
          temperature: 13 + index,
          low: null,
        })),
      },
    },
  };
}
async function open(page: Page) {
  await page.clock.setFixedTime(new Date(now));
  await page.route("**/weather-preview", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block;overflow:hidden}</style>
    </head><body><iframe title="Weather Hours face" sandbox="allow-scripts"
    src="/faces/builtin-weather/1.0.0/index.html"></iframe></body></html>`,
    }),
  );
  await page.goto("/weather-preview");
  return page.frameLocator('iframe[title="Weather Hours face"]');
}
async function connect(
  page: Page,
  data: FaceData = weatherData(),
  config: Settings = defaults,
  timezone = "UTC",
) {
  await page.evaluate(
    ({ data, config, timezone }) =>
      new Promise<void>((resolve) => {
        const host = window as typeof window & { weatherPort?: MessagePort };
        host.weatherPort?.close();
        const channel = new MessageChannel();
        host.weatherPort = channel.port1;
        channel.port1.onmessage = ({ data: message }) => {
          if (message.type === "ready")
            channel.port1.postMessage({
              type: "update",
              config,
              data,
              context: { timezone, locale: "en-GB", name: "Outside" },
            });
          if (message.type === "applied") resolve();
        };
        document
          .querySelector("iframe")!
          .contentWindow!.postMessage(
            { type: "screensvr:connect", protocols: [4, 3, 2, 1] },
            "*",
            [channel.port2],
          );
      }),
    { data, config, timezone },
  );
}

test("Weather Hours renders daily/hourly forecasts and restrained condition-driven backgrounds", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  await page.setViewportSize({ width: 1280, height: 800 });
  const face = await open(page);
  await connect(page);
  await expect(face.locator("#clock")).toHaveText("12:08");
  await expect(face.locator("#temperature")).toHaveText("12.5");
  await expect(face.locator("#condition")).toHaveText("Rain");
  await expect(face.locator("html")).toHaveAttribute("data-sky", "rain");
  await expect(face.locator(".forecast-entry")).toHaveCount(3);
  await expect(face.locator(".forecast-time").first()).toHaveText("Today");
  await expect(face.locator(".forecast-temperature").first()).toHaveText(
    "15°C / 7°C",
  );
  await expect(face.locator(".precipitation i")).toHaveCount(28);
  await expect(face.locator(".precipitation i").first()).toHaveCSS(
    "animation-name",
    "rain",
  );
  await expect(face.locator(".precipitation")).toHaveCSS("opacity", "1", {
    timeout: 7000,
  });
  await page.screenshot({ path: testInfo.outputPath("weather-rain.png") });

  await connect(page, weatherData("snow"));
  await expect(face.locator("html")).toHaveAttribute("data-sky", "snow");
  await expect(face.locator(".precipitation i").first()).toHaveCSS(
    "animation-name",
    "snow",
  );
  await page.screenshot({ path: testInfo.outputPath("weather-snow.png") });
  await connect(page, weatherData("clear-day"), {
    ...defaults,
    forecast: "hourly",
  });
  await expect(face.locator("html")).toHaveAttribute("data-sky", "clear-day");
  await expect(face.locator(".light")).toHaveCSS("opacity", "1", {
    timeout: 7000,
  });
  await expect(face.locator(".forecast-entry")).toHaveCount(6);
  await expect(face.locator(".forecast-temperature").first()).toHaveText(
    "13°C",
  );
  await page.screenshot({
    path: testInfo.outputPath("weather-clear-hourly.png"),
  });
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 320, height: 180 },
  ]) {
    await page.setViewportSize(viewport);
    for (const selector of ["#clock", "#current", "#forecast"]) {
      const bounds = (await face.locator(selector).boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
    }
    if (viewport.width === 390)
      await page.screenshot({
        path: testInfo.outputPath("weather-portrait.png"),
      });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await connect(page, weatherData("rain", true));
  await expect(face.locator("html")).toHaveAttribute("data-sky", "neutral");
  await expect(face.locator("#temperature")).toHaveText("12.5");
  await expect(face.locator("#weather-status")).toHaveText(
    "Last reading · stale",
  );
  await expect(face.locator("#forecast-status")).toHaveText(
    "Last forecast · stale",
  );
  await page.screenshot({ path: testInfo.outputPath("weather-stale.png") });
  await connect(page, {});
  await expect(face.locator("#temperature")).toHaveText("—");
  await expect(face.locator("#condition")).toHaveText("Weather not connected");
  await expect(face.locator(".forecast-entry")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("weather-missing.png") });
  await connect(
    page,
    weatherData(),
    {
      ...defaults,
      format: "12",
      location: "<img src=x onerror=alert(1)>",
      showDate: false,
      forecast: "off",
    },
    "America/New_York",
  );
  await expect(face.locator("#clock")).toHaveText("07:08");
  await expect(face.locator("#period")).toHaveText("am");
  await expect(face.locator("#date")).toBeHidden();
  await expect(face.locator("#forecast")).toBeHidden();
  await expect(face.locator("#location img")).toHaveCount(0);
  await expect(face.locator("#location")).toHaveText(
    "<img src=x onerror=alert(1)>",
  );
  expect(
    requests.every((url) => new URL(url).origin === new URL(page.url()).origin),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("weather motion can be disabled, respects reduced motion and pauses while hidden", async ({
  page,
}) => {
  const face = await open(page);
  await connect(page, weatherData("snow"), { ...defaults, motion: false });
  await expect(face.locator(".precipitation")).toBeHidden();
  await expect(face.locator(".cloud").first()).toHaveCSS(
    "animation-name",
    "none",
  );
  await connect(page, weatherData("snow"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(face.locator(".precipitation")).toBeHidden();
  await expect(face.locator(".light")).toHaveCSS("animation-name", "none");
  await expect(face.locator("#clock")).toBeVisible();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const frame = page
    .frames()
    .find((frame) => frame.url().includes("/faces/builtin-weather/"))!;
  await frame.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(face.locator(".precipitation i").first()).toHaveCSS(
    "animation-play-state",
    "paused",
  );
});

test("forecasts roll over locally and distinguish repeated DST hours", async ({
  page,
}) => {
  const face = await open(page);
  await connect(page);
  await expect(face.locator(".forecast-time").first()).toHaveText("Today");
  await page.clock.setFixedTime(new Date("2026-11-18T00:01:00Z"));
  const frame = page
    .frames()
    .find((frame) => frame.url().includes("/faces/builtin-weather/"))!;
  await frame.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await expect(face.locator(".forecast-entry")).toHaveCount(3);
  await expect(face.locator(".forecast-temperature").first()).toHaveText(
    "16°C / 7°C",
  );
  await expect(face.locator("#forecast-status")).toHaveText(
    "Last forecast · stale",
  );

  await page.clock.setFixedTime(new Date("2026-11-01T05:05:00Z"));
  const data = weatherData();
  data.hourly.value = {
    entries: [
      {
        at: Date.parse("2026-11-01T05:00:00Z"),
        temperature: 8,
        low: null,
        condition: "rain",
      },
      {
        at: Date.parse("2026-11-01T06:00:00Z"),
        temperature: 7,
        low: null,
        condition: "rain",
      },
    ],
  };
  await connect(
    page,
    data,
    { ...defaults, forecast: "hourly" },
    "America/New_York",
  );
  const hours = await face.locator(".forecast-time").allTextContents();
  expect(hours).toHaveLength(2);
  expect(hours[0]).not.toBe(hours[1]);
  expect(hours.every((hour) => hour.includes("01"))).toBe(true);
});

test("configure, preview, save and update live Home Assistant weather without upstream browser access", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(60000);
  const fake = await FakeHomeAssistant.start();
  // Isolate authentication quotas from other management specs. Keep the real
  // server's authentication, CSRF, and rate-limit behavior enabled.
  const directory = await temporaryDirectory("screensvr-weather-browser-");
  const server = await createApp({ dataDir: directory });
  const base = await server.app.listen({ port: 0, host: "127.0.0.1" });
  const displayContext = await browser.newContext();
  const display = await displayContext.newPage();
  const requests: string[] = [];
  display.on("request", (request) => requests.push(request.url()));
  try {
    await page.goto(base);
    await page
      .getByLabel("Administrator password")
      .fill("a-long-browser-test-password");
    await page.getByRole("button", { name: /Create password|Sign in/ }).click();
    await expect(
      page.getByRole("button", { name: "Add display", exact: true }),
    ).toBeVisible();
    const authentication = await (
      await page.request.get(`${base}/api/auth/status`)
    ).json();
    const integrationResponse = await page.request.post(
      `${base}/api/integrations`,
      {
        headers: { "x-csrf-token": authentication.csrf },
        data: {
          type: "home-assistant",
          name: `Weather home ${testInfo.project.name}`,
          baseUrl: fake.url,
          token: fakeToken,
        },
      },
    );
    expect(integrationResponse.status()).toBe(201);
    const integration = await integrationResponse.json();
    await expect
      .poll(async () => {
        const response = await page.request.get(`${base}/api/integrations`);
        return (await response.json()).find(
          (item: { id: string }) => item.id === integration.id,
        )?.status;
      })
      .toBe("connected");
    await page.reload();
    const name = `Weather ${testInfo.project.name}`;
    await page
      .getByRole("button", { name: "Add display", exact: true })
      .click();
    await page.getByLabel("Display name", { exact: true }).fill(name);
    await page.getByRole("combobox", { name: "Face", exact: true }).click();
    await page
      .getByRole("option", { name: "Weather Hours", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Create display", exact: true })
      .click();
    const link = await page.getByLabel("Display URL").inputValue();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await display.goto(link);
    const live = display.frameLocator('iframe[title="Weather Hours face"]');
    await expect(live.locator("#temperature")).toHaveText("—");
    await page
      .getByRole("button", { name: `Configure ${name}`, exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    for (const [label, source] of [
      ["Current weather", "Home weather (weather.home)"],
      ["Daily forecast", "Home weather · daily forecast (weather.home:daily)"],
      [
        "Hourly forecast",
        "Home weather · hourly forecast (weather.home:hourly)",
      ],
    ]) {
      await dialog
        .getByRole("combobox", { name: `${label} integration` })
        .click();
      await page
        .getByRole("option", { name: integration.name, exact: true })
        .click();
      await dialog
        .getByRole("combobox", { name: `${label} weather source` })
        .click();
      await page.getByRole("option", { name: source, exact: true }).click();
    }
    const preview = dialog.frameLocator('iframe[title="Weather Hours face"]');
    await expect(preview.locator("#temperature")).toHaveText("12.5");
    await expect(preview.locator(".forecast-entry")).toHaveCount(3);
    await expect(live.locator("#temperature")).toHaveText("—");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(live.locator("#temperature")).toHaveText("12.5");
    await expect(live.locator("html")).toHaveAttribute("data-sky", "rain");
    fake.set("weather.home", "snowy", {
      friendly_name: "Home weather",
      temperature: -2,
      temperature_unit: "°C",
      supported_features: 3,
    });
    await expect(live.locator("html")).toHaveAttribute("data-sky", "snow");
    await expect(live.locator("#temperature")).toHaveText("-2");
    fake.setForecast("weather.home", "daily", null);
    await expect(live.locator("#forecast-status")).toHaveText(
      "Forecast unavailable",
    );
    await expect(live.locator("#temperature")).toHaveText("-2");
    const state = await display.request.get(
      `${base}${new URL(link).pathname.replace("/display/", "/api/display/")}/state`,
    );
    const body = await state.text();
    expect(body).not.toMatch(/weather\.home|DO NOT EXPOSE|private_attribute/);
    expect(body).not.toContain(fakeToken);
    expect(requests.some((url) => url.startsWith(fake.url))).toBe(false);
  } finally {
    await displayContext.close();
    await page.goto("about:blank");
    await server.app.close();
    await fake.close();
    await rm(directory, { recursive: true, force: true });
  }
});
