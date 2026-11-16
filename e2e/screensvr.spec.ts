import { test, expect } from "@playwright/test";
import { faceZip } from "../tests/helpers.js";

test("manage a live display, reconnect, and install a framework-independent ZIP face", async ({
  page,
  browser,
}, testInfo) => {
  const suffix = testInfo.project.name;
  const displayName = `Hallway ${suffix}`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page
    .getByLabel("Administrator password")
    .fill("a-long-browser-test-password");
  await page.getByRole("button", { name: /Create your space|Sign in/ }).click();
  await expect(
    page.getByRole("heading", { name: "Make room for a little calm." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add display", exact: true }).click();
  await page.getByLabel("Display name", { exact: true }).fill(displayName);
  await page.getByLabel("Start with a face").selectOption("builtin-digital");
  await page
    .getByRole("button", { name: "Create display", exact: true })
    .click();
  const link = await page.getByLabel("Display URL").inputValue();
  const displayContext = await browser.newContext();
  const display = await displayContext.newPage();
  display.on("pageerror", (error) => errors.push(error.message));
  try {
    await display.goto(link);
    const digital = display.frameLocator('iframe[title="Slow Hours face"]');
    await expect(digital.locator("#caption")).toHaveText("Be here, now.");
    await expect(display).not.toHaveURL(/#/);
    expect((await displayContext.request.get("/api/devices")).status()).toBe(
      401,
    );
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page
      .getByRole("button", { name: `Configure ${displayName}`, exact: true })
      .click();
    await page.getByLabel("A small reminder").fill("Take a breath.");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(digital.locator("#caption")).toHaveText("Take a breath.");

    await displayContext.setOffline(true);
    await page
      .getByRole("button", { name: `Configure ${displayName}`, exact: true })
      .click();
    await page.getByLabel("A small reminder").fill("A moment, just for you.");
    await page.getByRole("button", { name: "Save changes" }).click();
    await displayContext.setOffline(false);
    await expect(digital.locator("#caption")).toHaveText(
      "A moment, just for you.",
      { timeout: 15000 },
    );
    await display.reload();
    await expect(digital.locator("#caption")).toHaveText(
      "A moment, just for you.",
    );

    await page.getByRole("button", { name: /Face library/ }).click();
    const existing = page.getByRole("heading", {
      name: "Test Face",
      exact: true,
    });
    if (!(await existing.count())) {
      await page
        .locator('input[type="file"]')
        .setInputFiles({
          name: "test-face.zip",
          mimeType: "application/zip",
          buffer: faceZip(),
        });
      await page.getByLabel("I trust the source of this package.").check();
      await page
        .getByRole("button", { name: "Install face", exact: true })
        .click();
      await expect(existing).toBeVisible();
    }
    await page.getByRole("button", { name: /^Displays/ }).click();
    await page
      .getByRole("button", { name: `Configure ${displayName}`, exact: true })
      .click();
    await page.getByLabel("Screen face").selectOption("test-face");
    await page
      .getByLabel("Caption", { exact: true })
      .fill("A face from a ZIP.");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(
      display
        .frameLocator('iframe[title="Test Face face"]')
        .locator("#caption"),
    ).toHaveText("A face from a ZIP.");
    const frame = display
      .frames()
      .find((frame) => frame.url().includes("/faces/test-face/"))!;
    expect(
      await frame.evaluate(() => {
        try {
          void document.cookie;
          return "accessible";
        } catch {
          return "blocked";
        }
      }),
    ).toBe("blocked");
    expect(
      await frame.evaluate(async () => {
        try {
          await fetch("/api/faces");
          return "accessible";
        } catch {
          return "blocked";
        }
      }),
    ).toBe("blocked");
    expect(errors).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("management.png"),
      fullPage: true,
    });
  } finally {
    await displayContext.close();
  }
});
