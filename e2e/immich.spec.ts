import { test, expect } from "@playwright/test";
import { FakeImmich, immichToken } from "../tests/fake-immich.js";

test("connect Immich, preview an album privately, and display photos without upstream browser access", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(60000);
  const fake = await FakeImmich.start();
  const name = `Immich ${testInfo.project.name}`;
  const connectionName = `Photo library ${testInfo.project.name}`;
  const context = await browser.newContext();
  const display = await context.newPage();
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  display.on("request", (request) => requests.push(request.url()));
  display.on("pageerror", (error) => errors.push(error.message));
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
    await page.getByRole("combobox", { name: "Integration type" }).click();
    await page.getByRole("option", { name: "Immich", exact: true }).click();
    await page.getByLabel("Connection name").fill(connectionName);
    await page.getByLabel("Immich URL").fill(fake.url);
    await page.getByLabel("API key", { exact: true }).fill(immichToken);
    await page
      .getByRole("button", { name: "Test connection", exact: true })
      .click();
    await expect(page.getByText("Connection successful.")).toBeVisible();
    await page
      .getByRole("button", { name: "Save integration", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page
      .getByRole("button", { name: `Configure ${connectionName}` })
      .click();
    await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: /^Displays/ }).click();
    await page
      .getByRole("button", { name: "Add display", exact: true })
      .click();
    await page.getByLabel("Display name", { exact: true }).fill(name);
    await page.getByRole("combobox", { name: "Start with a face" }).click();
    await page
      .getByRole("option", { name: "Photo Hours", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Create display", exact: true })
      .click();
    const link = await page.getByLabel("Display URL").inputValue();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await display.goto(link);
    const live = display.frameLocator('iframe[title="Photo Hours face"]');
    await expect(live.locator("#photo")).toBeHidden();
    await page
      .getByRole("button", { name: `Configure ${name}`, exact: true })
      .click();
    await page.getByLabel("Seconds between photos").fill("5");
    await page.getByLabel("Shuffle photos").uncheck();
    await page.getByRole("combobox", { name: "Photos integration" }).click();
    await page
      .getByRole("option", { name: connectionName, exact: true })
      .click();
    await page.getByRole("combobox", { name: "Photos photo source" }).click();
    await page.getByRole("option", { name: "Family", exact: true }).click();
    const preview = page
      .getByRole("dialog")
      .frameLocator('iframe[title="Photo Hours face"]');
    await expect(preview.locator("#photo")).toBeVisible();
    await expect(live.locator("#photo")).toBeHidden();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(live.locator("#photo")).toBeVisible();
    const first = await live.locator("#photo").getAttribute("src");
    await expect(live.locator("#photo")).not.toHaveAttribute("src", first!, {
      timeout: 12000,
    });
    const frame = display
      .frames()
      .find((frame) => frame.url().includes("/faces/builtin-photos/"))!;
    expect(
      await frame.evaluate(() => {
        const image = document.getElementById("photo") as HTMLImageElement;
        return image.complete && image.naturalWidth > 0;
      }),
    ).toBe(true);
    expect(
      requests.some(
        (url) => url.startsWith(fake.url) || url.includes(immichToken),
      ),
    ).toBe(false);
    const state = await display.request.get(
      new URL(link).pathname.replace("/display/", "/api/display/") + "/state",
    );
    const body = await state.text();
    for (const secret of [
      fake.url,
      immichToken,
      fake.family,
      "Family",
      "originalPath",
    ])
      expect(body).not.toContain(secret);
    await page
      .getByRole("button", { name: `Configure ${name}`, exact: true })
      .click();
    await page.getByRole("combobox", { name: "Photos photo source" }).click();
    await page
      .getByRole("option", { name: "Shared holidays", exact: true })
      .click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(live.locator("#photo")).toHaveAttribute("src", /index=0/);
    await page
      .getByRole("button", { name: `Configure ${name}`, exact: true })
      .click();
    await page.getByRole("combobox", { name: "Photos integration" }).click();
    await page
      .getByRole("option", { name: "Not connected", exact: true })
      .click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(live.locator("#photo")).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await fake.close();
  }
});
