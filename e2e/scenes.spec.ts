import { test, expect } from "@playwright/test";
import type { Device } from "../src/shared/contracts.js";
import type { SceneConfiguration } from "../src/shared/scenes.js";

test("schedule photos, an evening clock, and a near-black night clock", async ({
  page,
  browser,
}, testInfo) => {
  const name = `Routine ${testInfo.project.name}`;
  await page.goto("/");
  await page
    .getByLabel("Administrator password")
    .fill("a-long-browser-test-password");
  await page.getByRole("button", { name: /Create your space|Sign in/ }).click();
  await expect(
    page.getByRole("heading", { name: "Make room for a little calm." }),
  ).toBeVisible();
  const csrf = (await (await page.request.get("/api/auth/status")).json()).csrf;
  const headers = { "x-csrf-token": csrf };
  const created = await page.request.post("/api/devices", {
    headers,
    data: { name, faceId: "builtin-photos", timezone: "UTC" },
  });
  expect(created.status()).toBe(201);
  const { id, displayUrl } = await created.json();
  const integrations = await (
    await page.request.get("/api/integrations")
  ).json();
  let integration = integrations.find(
    (item: { type: string; folder?: string }) =>
      item.type === "mounted-folder" && item.folder === "family",
  );
  if (!integration) {
    const added = await page.request.post("/api/integrations", {
      headers,
      data: {
        type: "mounted-folder",
        name: "Scheduled family photos",
        folder: "family",
      },
    });
    expect(added.status()).toBe(201);
    integration = await added.json();
  }
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/integrations/${integration.id}/sources?type=image`,
      );
      return response.status();
    })
    .toBe(200);
  const sources = (
    await (
      await page.request.get(
        `/api/integrations/${integration.id}/sources?type=image`,
      )
    ).json()
  ).sources;
  const root = sources.find(
    (source: { label: string }) => source.label === "All photos /",
  );
  const device: Device = (
    await (await page.request.get("/api/devices")).json()
  ).find((device: Device) => device.id === id);
  const bound = await page.request.patch(
    `/api/devices/${id}/scenes/${device.activeSceneId}`,
    {
      headers,
      data: {
        revision: device.revision,
        bindings: {
          photos: { integrationId: integration.id, sourceId: root.id },
        },
      },
    },
  );
  expect(bound.status()).toBe(200);
  await page.request.post("/__test/schedule-time", {
    data: { now: Date.parse("2026-11-16T08:00:00Z") },
  });
  const displayContext = await browser.newContext();
  const display = await displayContext.newPage();
  const errors: string[] = [];
  display.on("pageerror", (error) => errors.push(error.message));
  try {
    await display.goto(displayUrl);
    const photos = display.frameLocator('iframe[title="Photo Hours face"]');
    await expect(photos.locator("img").first()).toBeVisible();
    await page.reload();
    await page
      .getByRole("button", {
        name: `Scenes & schedule for ${name}`,
        exact: true,
      })
      .click();
    await page.getByLabel("Scene name", { exact: true }).fill("Daytime photos");
    await page.getByRole("button", { name: "Save scene", exact: true }).click();
    await page.getByRole("button", { name: "New scene", exact: true }).click();
    await expect(page.getByLabel("Scene name", { exact: true })).toHaveValue(
      "New scene",
    );
    await page.getByLabel("Scene name", { exact: true }).fill("Evening clock");
    await page.getByLabel("A small reminder").fill("Evening routine");
    await page.getByRole("button", { name: "Save scene", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Save scene", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Add night clock", exact: true })
      .click();
    await expect(page.getByLabel("Near-black night clock")).toBeChecked();
    // Creating and editing inactive scenes never replaces the live photos.
    await expect(photos.locator("img").first()).toBeVisible();
    await page
      .getByRole("button", { name: "Weekly schedule", exact: true })
      .click();
    for (const [index, time, scene] of [
      [1, "07:00", "Daytime photos"],
      [2, "19:00", "Evening clock"],
      [3, "23:00", "Night clock"],
      [4, "09:00", "Daytime photos"],
    ] as const) {
      await page
        .getByRole("button", { name: "Add schedule entry", exact: true })
        .click();
      await page
        .getByLabel(`Entry ${index} start time`, { exact: true })
        .fill(time);
      await page
        .getByRole("combobox", { name: `Entry ${index} scene`, exact: true })
        .click();
      await page.getByRole("option", { name: scene, exact: true }).click();
    }
    for (const day of ["Sat", "Sun"])
      await page.getByLabel(`Entry 1 ${day}`, { exact: true }).uncheck();
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"])
      await page.getByLabel(`Entry 4 ${day}`, { exact: true }).uncheck();
    await page.getByLabel("Enable scheduling").check();
    await page
      .getByRole("button", { name: "Save schedule", exact: true })
      .click();
    await expect(
      page.getByText("Current scene:", { exact: false }),
    ).toContainText("Scheduled");
    await page.getByRole("button", { name: "Scenes", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Activate scene", exact: true }),
    ).toBeDisabled();
    const scheduled: SceneConfiguration = await (
      await page.request.get(`/api/devices/${id}/scenes`)
    ).json();
    await page.request.post("/__test/schedule-time", {
      data: { now: Date.parse("2026-11-16T19:00:00Z") },
    });
    const clock = display.frameLocator('iframe[title="Slow Hours face"]');
    await expect(clock.locator("#caption")).toHaveText("Evening routine");
    await page.request.post("/__test/schedule-time", {
      data: { now: Date.parse("2026-11-16T23:00:00Z") },
    });
    await expect(clock.locator("html")).toHaveAttribute("data-night", "true");
    await expect(clock.locator("body")).toHaveCSS(
      "background-color",
      "rgb(0, 0, 0)",
    );
    await expect(clock.locator(".glow")).toBeHidden();
    await expect(clock.locator("#caption")).toBeHidden();
    expect(
      (await (await page.request.get(`/api/devices/${id}/scenes`)).json())
        .revision,
    ).toBe(scheduled.revision);
    // A cold night-mode load stays black until the face has applied its config.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await display.route("**/faces/builtin-digital/*/face.js", async (route) => {
      await gate;
      await route.continue();
    });
    await display.reload({ waitUntil: "domcontentloaded" });
    await expect(display.locator("iframe")).toHaveCSS("visibility", "hidden");
    await expect(display.locator(".display-shell")).toHaveCSS(
      "background-color",
      "rgb(0, 0, 0)",
    );
    release();
    await expect(display.locator("iframe")).toHaveCSS("visibility", "visible");
    await expect(clock.locator("body")).toHaveCSS(
      "background-color",
      "rgb(0, 0, 0)",
    );
    await display.unroute("**/faces/builtin-digital/*/face.js");
    // Weekend starts later, using the previous night's scene until 09:00.
    await page.request.post("/__test/schedule-time", {
      data: { now: Date.parse("2026-11-21T08:00:00Z") },
    });
    await expect(clock.locator("html")).toHaveAttribute("data-night", "true");
    await page.request.post("/__test/schedule-time", {
      data: { now: Date.parse("2026-11-21T09:00:00Z") },
    });
    await expect(photos.locator("img").first()).toBeVisible();
    const restored: SceneConfiguration = await (
      await page.request.get(`/api/devices/${id}/scenes`)
    ).json();
    expect(
      restored.scenes.find((scene) => scene.name === "Daytime photos")?.bindings
        .photos,
    ).toEqual({ integrationId: integration.id, sourceId: root.id });
    expect(errors).toEqual([]);
  } finally {
    await displayContext.close();
    await page.request.post("/__test/schedule-time", { data: { now: null } });
    await page.request.delete(`/api/devices/${id}`, { headers });
  }
});
