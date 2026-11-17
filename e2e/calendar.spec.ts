import { expect, test, type Page } from "@playwright/test";
import { rm } from "node:fs/promises";
import manifest from "../faces/builtin-calendar/manifest.json" with { type: "json" };
import type { FaceData } from "../src/shared/face-data.js";
import { createApp } from "../src/server/app.js";
import { temporaryDirectory } from "../tests/helpers.js";
import {
  FakeCalendar,
  calendarFeed,
  calendarEvent,
  calendarTimestamp,
} from "../tests/fake-calendar.js";
import { FakeHomeAssistant, fakeToken } from "../tests/fake-home-assistant.js";

const now = Date.parse("2026-11-17T12:08:00Z");
const defaults = Object.fromEntries(
  manifest.settings.map((setting) => [setting.key, setting.default]),
);
function datum(event: unknown, stale = false): FaceData {
  return {
    calendar: {
      type: "calendar",
      status: stale ? "stale" : "ready",
      unit: null,
      updatedAt: null,
      observedAt: now,
      expiresAt: now + 90000,
      value: { event, complete: !stale } as FaceData[string]["value"],
    },
  };
}
async function connect(page: Page, data: FaceData, timezone = "UTC") {
  await page.evaluate(
    ({ data, timezone, config }) =>
      new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = ({ data: message }) => {
          if (message.type === "ready")
            channel.port1.postMessage({
              type: "update",
              config,
              data,
              context: { timezone, locale: "en-GB" },
            });
          if (message.type === "applied") {
            channel.port1.close();
            resolve();
          }
        };
        document
          .querySelector("iframe")!
          .contentWindow!.postMessage(
            { type: "screensvr:connect", protocols: [5, 4, 3, 2, 1] },
            "*",
            [channel.port2],
          );
      }),
    { data, timezone, config: defaults },
  );
}
test("Calendar Hours renders safely, handles local rollover, and fits landscape and portrait", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.setFixedTime(new Date(now));
  await page.route("**/calendar-preview", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block}</style></head>
    <body><iframe title="Calendar Hours face" sandbox="allow-scripts" src="/faces/builtin-calendar/1.0.0/index.html"></iframe></body></html>`,
    }),
  );
  await page.goto("/calendar-preview");
  const face = page.frameLocator('iframe[title="Calendar Hours face"]');
  await connect(
    page,
    datum({
      kind: "timed",
      start: now - 60000,
      end: now + 60000,
      title: "<img src=x onerror=alert(1)>",
    }),
  );
  await expect(face.locator("#time")).toHaveText("12:08");
  await expect(face.locator("#label")).toHaveText("NOW");
  await expect(face.locator("#title")).toHaveText(
    "<img src=x onerror=alert(1)>",
  );
  await expect(face.locator("#title img")).toHaveCount(0);
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
    { width: 320, height: 180 },
  ]) {
    await page.setViewportSize(viewport);
    for (const selector of [".clock", ".appointment"]) {
      const bounds = (await face.locator(selector).boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
    }
    if (viewport.width !== 320)
      await page.screenshot({
        path: testInfo.outputPath(`calendar-${viewport.width}.png`),
      });
  }
  await connect(
    page,
    datum({
      kind: "all-day",
      startDate: "2026-11-17",
      endDate: "2026-11-18",
      title: null,
    }),
    "America/Los_Angeles",
  );
  await expect(face.locator("#when")).toHaveText("Today · All day");
  await expect(face.locator("#title")).toHaveText("Busy");
  await page.clock.setFixedTime(new Date("2026-11-18T08:00:00Z"));
  await page
    .frames()
    .find((frame) => frame.url().includes("/faces/builtin-calendar/"))!
    .evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(face.locator("#title")).toHaveText(
    "Updating your next appointment…",
  );
  await expect(face.locator("#status")).toHaveText(
    "Calendar may be out of date",
  );
  await connect(page, datum(null, true));
  await expect(face.locator("#title")).toHaveText("Calendar unavailable");
  await connect(page, {});
  await expect(face.locator("#title")).toHaveText("Your time, quietly.");
  expect(errors).toEqual([]);
});

test("configure feeds and Home Assistant, preview a merge, save and revoke title sharing", async ({
  page,
  browser,
}) => {
  test.setTimeout(60000);
  const feed = await FakeCalendar.start();
  const ha = await FakeHomeAssistant.start();
  const at = Date.now() + 3600000;
  feed.body = calendarFeed(
    calendarEvent(
      `UID:private-id\nDTSTART:${calendarTimestamp(at + 3600000)}\nDTEND:${calendarTimestamp(at + 5400000)}\nSUMMARY:Family visit\nDESCRIPTION:DO NOT EXPOSE`,
    ),
  );
  ha.calendars.set("calendar.work", [
    {
      start: { dateTime: new Date(at).toISOString() },
      end: { dateTime: new Date(at + 1800000).toISOString() },
      summary: "Team meeting",
      description: "DO NOT EXPOSE",
      location: "SECRET ROOM",
    },
  ]);
  const directory = await temporaryDirectory("calendar-browser-");
  const server = await createApp({ dataDir: directory });
  const base = await server.app.listen({ port: 0, host: "127.0.0.1" });
  const context = await browser.newContext();
  const display = await context.newPage();
  const requests: string[] = [];
  display.on("request", (request) => requests.push(request.url()));
  try {
    await page.goto(base);
    await page
      .getByLabel("Administrator password")
      .fill("a-long-calendar-browser-password");
    await page
      .getByRole("button", { name: /Create your space|Sign in/ })
      .click();
    await page.getByRole("button", { name: /^Integrations/ }).click();
    await page
      .getByRole("button", { name: "Add integration", exact: true })
      .click();
    await page.getByRole("combobox", { name: "Integration type" }).click();
    await page
      .getByRole("option", { name: "iCalendar feed", exact: true })
      .click();
    await page.getByLabel("Connection name").fill("Family calendar");
    await page.getByLabel("Subscription URL", { exact: true }).fill(feed.url);
    await page.getByLabel("Calendar timezone", { exact: true }).fill("UTC");
    await page
      .getByRole("button", { name: "Test connection", exact: true })
      .click();
    await expect(page.getByText("Connection successful.")).toBeVisible();
    await page
      .getByRole("button", { name: "Save integration", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const auth = await (
      await page.request.get(`${base}/api/auth/status`)
    ).json();
    const home = await page.request.post(`${base}/api/integrations`, {
      headers: { "x-csrf-token": auth.csrf },
      data: {
        type: "home-assistant",
        name: "Home calendars",
        baseUrl: ha.url,
        token: fakeToken,
      },
    });
    expect(home.status()).toBe(201);
    await page.reload();
    await page.getByRole("button", { name: /^Displays/ }).click();
    await page
      .getByRole("button", { name: "Add display", exact: true })
      .click();
    await page
      .getByLabel("Display name", { exact: true })
      .fill("Calendar wall");
    await page.getByRole("combobox", { name: "Start with a face" }).click();
    await page
      .getByRole("option", { name: "Calendar Hours", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Create display", exact: true })
      .click();
    const link = await page.getByLabel("Display URL").inputValue();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await display.goto(link);
    const live = display.frameLocator('iframe[title="Calendar Hours face"]');
    await expect(live.locator("#title")).toHaveText("Your time, quietly.");
    await page
      .getByRole("button", { name: "Configure Calendar wall", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    for (const [integration, source] of [
      ["Family calendar", "Family calendar (calendar)"],
      ["Home calendars", "work (calendar.work)"],
    ]) {
      await dialog
        .getByRole("combobox", {
          name: "Add calendar integration",
          exact: true,
        })
        .click();
      await page
        .getByRole("option", { name: integration, exact: true })
        .click();
      await dialog
        .getByRole("combobox", { name: "Add calendar calendar", exact: true })
        .click();
      await page.getByRole("option", { name: source, exact: true }).click();
    }
    const preview = dialog.frameLocator('iframe[title="Calendar Hours face"]');
    await expect(preview.locator("#title")).toHaveText("Busy");
    await expect(live.locator("#title")).toHaveText("Your time, quietly.");
    await dialog.getByLabel("Publish event titles").nth(1).check();
    await expect(preview.locator("#title")).toHaveText("Team meeting");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(live.locator("#title")).toHaveText("Team meeting");
    const publicState = `${base}${new URL(link).pathname.replace("/display/", "/api/display/")}/state`;
    const body = await (await display.request.get(publicState)).text();
    expect(body).not.toMatch(
      /calendar.work|private-id|DO NOT EXPOSE|SECRET ROOM|private-feed-token|feed-secret/,
    );
    expect(body).not.toContain(fakeToken);
    expect(
      requests.some(
        (url) => url.startsWith(feed.url) || url.startsWith(ha.url),
      ),
    ).toBe(false);
    await page
      .getByRole("button", { name: "Configure Calendar wall", exact: true })
      .click();
    await page.getByLabel("Publish event titles").nth(1).uncheck();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(live.locator("#title")).toHaveText("Busy");
    expect(await (await display.request.get(publicState)).text()).not.toContain(
      "Team meeting",
    );
  } finally {
    await context.close();
    await page.goto("about:blank");
    await server.app.close();
    await feed.close();
    await ha.close();
    await rm(directory, { recursive: true, force: true });
  }
});
