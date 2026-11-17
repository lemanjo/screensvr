import { test, expect } from "@playwright/test";

test("select mounted photos, preview privately, and display and rotate inside the sandbox", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(60000);
  const name = `Photos ${testInfo.project.name}`;
  const integrationName = `Pictures ${testInfo.project.name}`;
  await page.goto("/");
  await page
    .getByLabel("Administrator password")
    .fill("a-long-browser-test-password");
  await page.getByRole("button", { name: /Create your space|Sign in/ }).click();
  await page.getByRole("button", { name: /^Integrations/ }).click();
  await page
    .getByRole("button", { name: "Add integration", exact: true })
    .click();
  await page.getByRole("combobox", { name: "Integration type" }).click();
  await page
    .getByRole("option", { name: "Mounted photo folders", exact: true })
    .click();
  await page.getByLabel("Connection name").fill(integrationName);
  await page.getByLabel("Folder inside photo directory").fill("family");
  await page
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(page.getByText("Connection successful.")).toBeVisible();
  await page
    .getByRole("button", { name: "Save integration", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: /^Displays/ }).click();
  await page.getByRole("button", { name: "Add display", exact: true }).click();
  await page.getByLabel("Display name", { exact: true }).fill(name);
  await page.getByRole("combobox", { name: "Start with a face" }).click();
  await page.getByRole("option", { name: "Photo Hours", exact: true }).click();
  await page
    .getByRole("button", { name: "Create display", exact: true })
    .click();
  const link = await page.getByLabel("Display URL").inputValue();
  await page.getByRole("button", { name: "Close dialog" }).click();
  const context = await browser.newContext();
  const display = await context.newPage();
  const errors: string[] = [];
  display.on("pageerror", (error) => errors.push(error.message));
  try {
    await display.goto(link);
    const live = display.frameLocator('iframe[title="Photo Hours face"]');
    await expect(live.locator("#placeholder")).toHaveText(
      "Choose a photo source in display settings.",
    );
    await page
      .getByRole("button", { name: `Configure ${name}`, exact: true })
      .click();
    await page.getByLabel("Seconds between photos").fill("5");
    await page.getByLabel("Shuffle photos").uncheck();
    await page.getByRole("combobox", { name: "Photos integration" }).click();
    await page
      .getByRole("option", { name: integrationName, exact: true })
      .click();
    await page.getByRole("combobox", { name: "Photos photo source" }).click();
    await page
      .getByRole("option", { name: "All photos /", exact: true })
      .click();
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
      await frame.evaluate(async () => {
        const source = document.getElementById("photo") as HTMLImageElement;
        const image = new Image();
        image.crossOrigin = "anonymous";
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () =>
            reject(new Error("Anonymous photo load failed."));
          image.src = source.src;
        });
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0, 1, 1);
        return context.getImageData(0, 0, 1, 1).data[3];
      }),
    ).toBe(255);
    expect(
      await frame.evaluate(async () => {
        try {
          await fetch("/api/devices");
          return "accessible";
        } catch {
          return "blocked";
        }
      }),
    ).toBe("blocked");
    await page
      .getByRole("button", { name: `Configure ${name}`, exact: true })
      .click();
    await page.getByRole("combobox", { name: "Photos photo source" }).click();
    await page.getByRole("option", { name: "one.jpg", exact: true }).click();
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
  }
});
