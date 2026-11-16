import { test, expect, type Page } from "@playwright/test";

test.use({ timezoneId: "UTC" });

async function expectUnclippedMenu(page: Page) {
  const menu = page.getByRole("listbox");
  await expect(menu).toHaveCSS("position", "fixed");
  await expect(menu).toHaveCSS("background-color", "rgb(250, 251, 247)");
  const bounds = (await menu.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(
    page.viewportSize()!.height,
  );
  expect(
    await menu.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(bounds.left + 10, bounds.top + 10),
      );
    }),
  ).toBe(true);
}

test("display dropdowns are searchable, themed, keyboard accessible, and saved", async ({
  page,
}, testInfo) => {
  const displayName = `Dropdowns ${testInfo.project.name}`;
  await page.goto("/");
  await page
    .getByLabel("Administrator password")
    .fill("a-long-browser-test-password");
  await page.getByRole("button", { name: /Create your space|Sign in/ }).click();
  await page.getByRole("button", { name: "Add display", exact: true }).click();
  await page.getByLabel("Display name", { exact: true }).fill(displayName);
  await page.getByRole("combobox", { name: "Start with a face" }).click();
  await page.getByRole("option", { name: "Slow Hours", exact: true }).click();
  await page
    .getByRole("button", { name: "Create display", exact: true })
    .click();
  await expect(page.getByLabel("Display URL")).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  const configure = page.getByRole("button", {
    name: `Configure ${displayName}`,
    exact: true,
  });
  await configure.click();

  const dialog = page.getByRole("dialog");
  const timezone = page.getByRole("combobox", {
    name: "Timezone",
    exact: true,
  });
  await expect(timezone).toHaveValue("UTC");
  await timezone.click();
  expect(await page.getByRole("option").count()).toBeGreaterThan(300);
  await expect(
    page.getByRole("option", { name: "UTC", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expectUnclippedMenu(page);
  await timezone.fill("new_york");
  await page
    .getByRole("option", { name: "America/New York", exact: true })
    .click();
  await expect(timezone).toHaveValue("America/New York");

  // Reopening shows all zones, not only matches for the selected value.
  await timezone.click();
  expect(await page.getByRole("option").count()).toBeGreaterThan(300);
  await timezone.fill("not a timezone");
  await expect(page.getByRole("status")).toHaveText("No matching options.");
  await timezone.press("Enter");
  await expect(dialog).toBeVisible();
  await timezone.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(timezone).toHaveValue("America/New York");

  await timezone.click();
  await timezone.fill("london");
  await timezone.press("ArrowDown");
  await timezone.press("Enter");
  await expect(timezone).toHaveValue("Europe/London");

  const format = page.getByRole("combobox", {
    name: "Time format",
    exact: true,
  });
  await format.click();
  await expectUnclippedMenu(page);
  await format.press("ArrowDown");
  await format.press("Enter");
  await expect(format).toHaveText("12 hour");

  const face = page.getByRole("combobox", { name: "Screen face", exact: true });
  await face.focus();
  await face.press("s");
  await face.press("o");
  await face.press("f");
  await face.press("t");
  await face.press("Enter");
  await expect(face).toHaveText("Soft Orbit");
  await expect(page.getByLabel("A small reminder")).toHaveValue(
    "Make time for less.",
  );
  await face.click();
  await face.press("End");
  await expect(page.getByRole("option").last()).toHaveAttribute(
    "data-active",
    "true",
  );
  await face.press("Home");
  await expect(page.getByRole("option").first()).toHaveAttribute(
    "data-active",
    "true",
  );
  await face.press("Escape");
  await expect(face).toHaveText("Soft Orbit");
  await expect(dialog).toBeVisible();

  // Switching faces still resets face-specific settings to their defaults.
  await face.click();
  await page.getByRole("option", { name: "Slow Hours", exact: true }).click();
  await expect(format).toHaveText("24 hour");
  await face.click();
  await expectUnclippedMenu(page);
  await page.screenshot({
    path: testInfo.outputPath("display-settings-dropdown.png"),
  });
  await page.getByLabel("Display name", { exact: true }).click();
  await expect(page.getByRole("listbox")).toBeHidden();
  await face.click();
  await page.getByRole("option", { name: "Soft Orbit", exact: true }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  await configure.click();
  await expect(timezone).toHaveValue("Europe/London");
  await expect(face).toHaveText("Soft Orbit");

  // The menu stays usable outside the scrolling dialog on narrow screens.
  await page.setViewportSize({ width: 390, height: 844 });
  await timezone.click();
  await expectUnclippedMenu(page);
  await timezone.fill("utc");
  await page.getByRole("option", { name: "UTC", exact: true }).click();
  await expect(timezone).toHaveValue("UTC");
  await timezone.click();
  await timezone.press("Tab");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(face).toBeFocused();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await configure.click();
  await expect(timezone).toHaveValue("Europe/London");
});
