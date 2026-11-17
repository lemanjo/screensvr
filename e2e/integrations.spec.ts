import { test, expect } from "@playwright/test";
import { FakeHomeAssistant, fakeToken } from "../tests/fake-home-assistant.js";

test("configure Home Assistant, preview a binding, and stream selected data to a face", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(60000);
  const fake = await FakeHomeAssistant.start();
  const suffix = testInfo.project.name;
  const name = `Climate ${suffix}`;
  const connectionName = `Home ${suffix}`;
  const displayContext = await browser.newContext();
  const display = await displayContext.newPage();
  const requests: string[] = [];
  display.on("request", (request) => requests.push(request.url()));
  try {
    await page.goto("/");
    await page
      .getByLabel("Administrator password")
      .fill("a-long-browser-test-password");
    await page
      .getByRole("button", { name: /Create your space|Sign in/ })
      .click();
    await page.getByRole("button", { name: /^Integrations/ }).click();
    await page
      .getByRole("button", { name: "Add integration", exact: true })
      .click();
    await page.getByLabel("Connection name").fill(connectionName);
    await page.getByLabel("Home Assistant URL").fill(fake.url);
    await page.getByLabel("Long-lived access token").fill(fakeToken);
    await page
      .getByRole("button", { name: "Test connection", exact: true })
      .click();
    await expect(page.getByText("Connection successful.")).toBeVisible();
    await page
      .getByRole("button", { name: "Save integration", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.reload();
    await page.getByRole("button", { name: /^Integrations/ }).click();
    const card = page.locator(".integration-card").filter({
      has: page.getByRole("heading", { name: connectionName, exact: true }),
    });
    await expect(card.getByText("Connected", { exact: true })).toBeVisible({
      timeout: 20000,
    });
    await card
      .getByRole("button", { name: `Configure ${connectionName}` })
      .click();
    await expect(page.getByLabel("Long-lived access token")).toHaveValue("");
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: /^Displays/ }).click();
    await page
      .getByRole("button", { name: "Add display", exact: true })
      .click();
    await page.getByLabel("Display name", { exact: true }).fill(name);
    await page.getByRole("combobox", { name: "Start with a face" }).click();
    await page.getByRole("option", { name: "Slow Hours", exact: true }).click();
    await page
      .getByRole("button", { name: "Create display", exact: true })
      .click();
    const link = await page.getByLabel("Display URL").inputValue();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await display.goto(link);
    const live = display.frameLocator('iframe[title="Slow Hours face"]');
    await expect(live.locator("#temperature")).toBeHidden();
    await page
      .getByRole("button", { name: `Configure ${name}`, exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("combobox", { name: "Room temperature integration" })
      .click();
    await page
      .getByRole("option", { name: connectionName, exact: true })
      .click();
    await dialog
      .getByRole("combobox", { name: "Room temperature sensor" })
      .click();
    await page
      .getByRole("option", {
        name: "Living room temperature (sensor.living_room_temperature)",
        exact: true,
      })
      .click();
    await expect(
      dialog
        .frameLocator('iframe[title="Slow Hours face"]')
        .locator("#temperature"),
    ).toHaveText("21.3 °C");
    await expect(live.locator("#temperature")).toBeHidden();
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(live.locator("#temperature")).toHaveText("21.3 °C");
    const frame = display
      .frames()
      .find((frame) => frame.url().includes("/faces/builtin-digital/"))!;
    const initialTimeOrigin = await frame.evaluate(
      () => performance.timeOrigin,
    );
    fake.set("sensor.living_room_temperature", "23.5");
    await expect(live.locator("#temperature")).toHaveText("23.5 °C");
    expect(await frame.evaluate(() => performance.timeOrigin)).toBe(
      initialTimeOrigin,
    );
    expect(requests.some((url) => url.startsWith(fake.url))).toBe(false);
    const publicState = await display.request.get(
      new URL(link).pathname.replace("/display/", "/api/display/") + "/state",
    );
    const body = await publicState.text();
    expect(body).not.toContain(fakeToken);
    expect(body).not.toContain("sensor.living_room_temperature");
    expect(body).not.toContain("DO NOT EXPOSE");
    fake.set("sensor.living_room_temperature", "unavailable");
    await expect(live.locator("#temperature")).toBeHidden();
    fake.set("sensor.living_room_temperature", "20");
    await expect(live.locator("#temperature")).toHaveText("20 °C");
    await page
      .getByRole("button", { name: `Configure ${name}`, exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Room temperature integration" })
      .click();
    await page
      .getByRole("option", { name: "Not connected", exact: true })
      .click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(live.locator("#temperature")).toBeHidden();
    // A new manifest-v2 face uses the same saved connector, but receives data
    // only after the user explicitly selects its own source.
    await page
      .getByRole("button", { name: `Configure ${name}`, exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Screen face", exact: true })
      .click();
    await page.getByRole("option", { name: "Stillroom", exact: true }).click();
    const stillroomPreview = page
      .getByRole("dialog")
      .frameLocator('iframe[title="Stillroom face"]');
    await expect(stillroomPreview.locator("#temperature-value")).toHaveText(
      "—",
    );
    await page
      .getByRole("combobox", { name: "Room temperature integration" })
      .click();
    await page
      .getByRole("option", { name: connectionName, exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Room temperature sensor" })
      .click();
    await page
      .getByRole("option", {
        name: "Bedroom temperature (sensor.bedroom_temperature)",
        exact: true,
      })
      .click();
    await expect(stillroomPreview.locator("#temperature-value")).toHaveText(
      "19.2",
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    const stillroom = display.frameLocator('iframe[title="Stillroom face"]');
    await expect(stillroom.locator("#temperature-value")).toHaveText("19.2");
    fake.set("sensor.bedroom_temperature", "20.5");
    await expect(stillroom.locator("#temperature-value")).toHaveText("20.5");
    await expect(stillroom.locator("#temperature-unit")).toHaveText("°C");
  } finally {
    await displayContext.close();
    await fake.close();
  }
});
