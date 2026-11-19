import { test, expect } from "@playwright/test";
import { faceZip } from "../tests/helpers.js";

test("manage a live display, reconnect, and install a framework-independent ZIP face", async ({
  page,
  browser,
}, testInfo) => {
  const suffix = testInfo.project.name;
  const displayName = `Olohuone ${suffix}`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page
    .getByLabel("Administrator password")
    .fill("a-long-browser-test-password");
  await page.getByRole("button", { name: /Create password|Sign in/ }).click();
  await expect(
    page.getByRole("heading", { name: "Displays", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add display", exact: true }).click();
  await page.getByLabel("Display name", { exact: true }).fill(displayName);
  await page.getByRole("combobox", { name: "Face", exact: true }).click();
  await page.getByRole("option", { name: "Slow Hours", exact: true }).click();
  await page
    .getByRole("button", { name: "Create display", exact: true })
    .click();
  const link = await page.getByLabel("Display URL").inputValue();
  expect(new URL(link).pathname).toBe(`/display/olohuone-${suffix}`);
  expect(new URL(link).hash).toBe("");
  const devices = (await (await page.request.get("/api/devices")).json()) as {
    id: string;
    name: string;
  }[];
  const device = devices.find((device) => device.name === displayName)!;
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
    // Retrieving the link is repeatable and never revokes a connected screen.
    for (let attempt = 0; attempt < 2; attempt++) {
      await page
        .getByRole("button", {
          name: `Display link for ${displayName}`,
          exact: true,
        })
        .click();
      await expect(page.getByLabel("Display URL")).toHaveValue(link);
      await page.getByRole("button", { name: "Close dialog" }).click();
    }
    await displayContext.clearCookies();
    await display.reload();
    await expect(digital.locator("#caption")).toHaveText("Be here, now.");
    // Old UUID links migrate to the permanent address, discarding old secrets.
    await display.goto(
      new URL(`/display/${device.id}#old-pairing-secret`, link).href,
    );
    await expect(display).toHaveURL(link);
    await expect(digital.locator("#caption")).toHaveText("Be here, now.");
    await page
      .getByRole("button", { name: `Configure ${displayName}`, exact: true })
      .click();
    await page.getByLabel("Caption", { exact: true }).fill("Take a breath.");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(digital.locator("#caption")).toHaveText("Take a breath.");

    await displayContext.setOffline(true);
    await page
      .getByRole("button", { name: `Configure ${displayName}`, exact: true })
      .click();
    await page
      .getByLabel("Caption", { exact: true })
      .fill("A moment, just for you.");
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
      await page.locator('input[type="file"]').setInputFiles({
        name: "test-face.zip",
        mimeType: "application/zip",
        buffer: faceZip(),
      });
      const install = page.getByRole("dialog", { name: "Install face" });
      const confirm = install.getByRole("button", {
        name: "Install face",
        exact: true,
      });
      await expect(confirm).toBeDisabled();
      await expect(
        install.getByText(/sandboxing does not make untrusted code safe/),
      ).toBeVisible();
      await install.getByLabel("I trust the source of this package.").check();
      await confirm.click();
      await expect(existing).toBeVisible();
    }
    await page.getByRole("button", { name: /^Displays/ }).click();
    await page
      .getByRole("button", { name: `Configure ${displayName}`, exact: true })
      .click();
    await page.getByRole("combobox", { name: "Face", exact: true }).click();
    await page.getByRole("option", { name: "Test Face", exact: true }).click();
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
    const renamed = `Renamed ${suffix}`;
    await page
      .getByRole("button", { name: `Configure ${displayName}`, exact: true })
      .click();
    await page.getByLabel("Display name", { exact: true }).fill(renamed);
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.reload();
    await page
      .getByRole("button", { name: `Display link for ${renamed}`, exact: true })
      .click();
    await expect(page.getByLabel("Display URL")).toHaveValue(link);
    await page.getByRole("button", { name: "Close dialog" }).click();
    await display.reload();
    await expect(
      display
        .frameLocator('iframe[title="Test Face face"]')
        .locator("#caption"),
    ).toHaveText("A face from a ZIP.");
    await expect(display).toHaveURL(link);
    await expect(display.getByRole("status")).toBeHidden();
    await page
      .getByRole("button", { name: `Remove ${renamed}`, exact: true })
      .click();
    await page
      .getByRole("button", { name: "Remove display", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: `Configure ${renamed}`, exact: true }),
    ).toBeHidden();
    await expect(display.getByRole("alert")).toHaveText(
      "This display has been removed from management.",
    );
    // Bodyless mutations such as removal and sign-out must not send JSON headers.
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByLabel("Administrator password")).toBeVisible();
  } finally {
    await displayContext.close();
  }
});
