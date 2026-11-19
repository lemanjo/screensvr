import { expect, test, type Page } from "@playwright/test";
import digital from "../faces/builtin-digital/manifest.json" with { type: "json" };
import calendar from "../faces/builtin-calendar/manifest.json" with { type: "json" };
import photos from "../faces/builtin-photos/manifest.json" with { type: "json" };
import {
  manifestSchema,
  validateSettings,
  type Device,
} from "../src/shared/contracts.js";

const faces = [digital, calendar, photos].map((manifest) => ({
  manifest: manifestSchema.parse(manifest),
  builtin: true,
}));
const scene = {
  id: "default",
  name: "Default",
  faceId: digital.id,
  settings: validateSettings(faces[0].manifest, {}),
  bindings: {},
};
const device: Device = {
  id: "hallway",
  displayUrl: "/display/hallway",
  name: "Hallway",
  timezone: "UTC",
  revision: 1,
  faceId: scene.faceId,
  settings: scene.settings,
  bindings: {},
  data: {},
  online: false,
  lastSeen: null,
  scenes: [scene, { ...scene, id: "night", name: "Night" }],
  activeSceneId: scene.id,
  schedule: { enabled: false, entries: [] },
  nextTransition: null,
};

async function mockManagement(page: Page, devices: Device[] = [device]) {
  for (const [endpoint, json] of [
    ["auth/status", { configured: true, authenticated: true, csrf: "ui-test" }],
    ["faces", faces],
    ["devices", devices],
    ["integrations", []],
    [`devices/${device.id}/scenes`, device],
  ] as const) {
    await page.route(`**/api/${endpoint}`, (route) => route.fulfill({ json }));
  }
}

async function expectNoOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

for (const configured of [false, true]) {
  test(`${configured ? "sign-in" : "setup"} shows only the form and necessary guidance`, async ({
    page,
  }, testInfo) => {
    await page.route("**/api/auth/status", (route) =>
      route.fulfill({ json: { configured, authenticated: false } }),
    );
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      configured ? "Sign in" : "Set up screensvr",
    );
    await expect(
      page.getByRole("button", {
        name: configured ? "Sign in" : "Create password",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByLabel("Administrator password")).toHaveAttribute(
      "autocomplete",
      configured ? "current-password" : "new-password",
    );
    await expect(page.getByText("At least 12 characters.")).toHaveCount(
      configured ? 0 : 1,
    );
    await expect(page.getByText(/Set up on a trusted network/)).toHaveCount(
      configured ? 0 : 1,
    );
    await expect(page.locator(".login-art, .local-note")).toHaveCount(0);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expectNoOverflow(page);
    }
    await page.screenshot({ path: testInfo.outputPath("login-mobile.png") });
  });
}

test("management pages have one title and primary action at desktop and mobile sizes", async ({
  page,
}, testInfo) => {
  await mockManagement(page, []);
  await page.goto("/");
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole("button", { name: /^Displays/ }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Displays",
    );
    await expect(
      page.getByRole("heading", { name: "No displays" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Add display", exact: true }),
    ).toHaveCount(1);
    await expect(
      page.locator(".topbar, .local-card, .page-footer, .add-card, .eyebrow"),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expectNoOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`displays-${width}.png`),
      fullPage: true,
    });

    await page.getByRole("button", { name: /^Face library/ }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Face library",
    );
    await expect(
      page.getByRole("button", { name: "Install face", exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByText(digital.description, { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".library-footer")).toHaveCount(0);
    await expectNoOverflow(page);

    await page.getByRole("button", { name: /^Integrations/ }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Integrations",
    );
    await expect(
      page.getByRole("button", { name: "Add integration", exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("heading", { name: "No integrations" }),
    ).toBeVisible();
    await expectNoOverflow(page);
  }
});

test("help is expandable while privacy warnings and save behavior remain visible", async ({
  page,
}, testInfo) => {
  await mockManagement(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: /^Integrations/ }).click();
  await page
    .getByRole("button", { name: "Add integration", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveAccessibleName("Add integration");
  const setup = dialog.locator("details").filter({ hasText: "Setup help" });
  await expect(setup).not.toHaveAttribute("open");
  await expect(
    dialog.getByText(/Tokens may allow more than read access/),
  ).toBeVisible();
  await page
    .getByLabel("Home Assistant URL")
    .fill("http://homeassistant.local:8123");
  await expect(
    dialog.getByText(/HTTP sends credentials unencrypted/),
  ).toBeVisible();
  await setup.locator("summary").focus();
  await page.keyboard.press("Space");
  await expect(setup).toHaveAttribute("open", "");
  await expect(
    setup.getByText(/Create a long-lived access token/),
  ).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Enabled", { exact: true })).toBeFocused();
  await expectNoOverflow(page);
  await page.getByRole("button", { name: "Close dialog" }).click();

  await page.getByRole("button", { name: /^Displays/ }).click();
  await page
    .getByRole("button", { name: "Configure Hallway", exact: true })
    .click();
  await expect(dialog).toHaveAccessibleName("Display settings");
  await expect(dialog.getByText("Changes apply when saved.")).toBeVisible();
  await expect(page.getByLabel("Caption", { exact: true })).toHaveValue(
    "Be here, now.",
  );
  await page.getByRole("combobox", { name: "Face", exact: true }).click();
  await page
    .getByRole("option", { name: "Calendar Hours", exact: true })
    .click();
  await expect(
    dialog.getByText(/Saving clears the previous face’s settings/),
  ).toBeVisible();
  await expect(
    dialog.getByText(/Published titles are readable by anyone/),
  ).toBeVisible();
  const calendarHelp = dialog
    .locator("details")
    .filter({ hasText: "Calendar details" });
  await expect(calendarHelp).not.toHaveAttribute("open");
  await calendarHelp.locator("summary").click();
  await expect(
    calendarHelp.getByText(/Combine up to eight calendars/),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Face", exact: true }).click();
  await page.getByRole("option", { name: "Photo Hours", exact: true }).click();
  await expect(
    dialog.getByText(/Photo sources share the entire selected folder or album/),
  ).toBeVisible();
  await expectNoOverflow(page);
  await page.getByRole("button", { name: "Close dialog" }).click();

  await page
    .getByRole("button", { name: "Scenes & schedule for Hallway" })
    .click();
  await expect(dialog.getByText("Changes apply when saved.")).toBeVisible();
  await page.getByRole("combobox", { name: "Saved scene" }).click();
  await page.getByRole("option", { name: "Night", exact: true }).click();
  await expect(
    dialog.getByText("Saving won’t activate this scene."),
  ).toBeVisible();
  await page.route("**/api/devices/hallway/scenes/night/activate", (route) =>
    route.fulfill({
      json: { ...device, revision: 2, activeSceneId: "night" },
    }),
  );
  await page
    .getByRole("button", { name: "Activate scene", exact: true })
    .click();
  await expect(dialog.getByText("Changes apply when saved.")).toBeVisible();
  await page
    .getByRole("button", { name: "Weekly schedule", exact: true })
    .click();
  const schedule = dialog
    .locator("details")
    .filter({ hasText: "Schedule details" });
  await expect(schedule).not.toHaveAttribute("open");
  await expect(
    dialog.getByText(/Disabling scheduling keeps the current scene/),
  ).toBeVisible();
  await schedule.locator("summary").click();
  await expect(schedule.getByText(/When clocks move forward/)).toBeVisible();
  await expectNoOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("schedule-help-mobile.png"),
    fullPage: true,
  });
});
