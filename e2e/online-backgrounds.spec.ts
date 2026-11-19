import { test, expect } from "@playwright/test";
import { rm } from "node:fs/promises";
import { createApp } from "../src/server/app.js";
import { temporaryDirectory } from "../tests/helpers.js";

test("pick automatically enabled online albums without integration setup and preview credited images in the sandbox", async ({
  page,
}, testInfo) => {
  const name = `Online ${testInfo.project.name}`;
  const connectionName = "Online backgrounds";
  // Keep this flow's sign-ins independent of the shared browser-test server's
  // real authentication quota, just like the calendar integration tests.
  const directory = await temporaryDirectory("online-backgrounds-browser-");
  const server = await createApp({ dataDir: directory });
  const base = await server.app.listen({ port: 0, host: "127.0.0.1" });
  try {
    // Browser rendering uses fixed responses, not public internet availability.
    const credit = {
      title: "A peaceful landscape",
      attribution: "A. Photographer",
      source: "Wikimedia Commons",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:Landscape.jpg",
      license: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    };
    await page.route("**/api/devices/*/preview", (route) => {
      const binding = route.request().postDataJSON().bindings?.photos;
      return route.fulfill({
        json: {
          data: {
            photos: {
              type: "image",
              status: binding ? "ready" : "unbound",
              value: binding
                ? {
                    count: 1,
                    revision: "a".repeat(64),
                    url: `/api/photos/${"x".repeat(32)}`,
                    credits: [credit],
                  }
                : null,
              unit: null,
              updatedAt: Date.now(),
              observedAt: Date.now(),
              expiresAt: Date.now() + 90000,
            },
          },
        },
      });
    });
    await page.route("**/api/photos/*", (route) =>
      route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=",
          "base64",
        ),
        headers: { "access-control-allow-origin": "*" },
      }),
    );
    await page.goto(base);
    await page
      .getByLabel("Administrator password")
      .fill("a-long-browser-test-password");
    await page.getByRole("button", { name: /Create password|Sign in/ }).click();
    // Go straight to display setup: no Integrations page or enable step.
    await page
      .getByRole("button", { name: "Add display", exact: true })
      .click();
    await page.getByLabel("Display name", { exact: true }).fill(name);
    await page.getByRole("combobox", { name: "Face", exact: true }).click();
    await page
      .getByRole("option", { name: "Photo Hours", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Create display", exact: true })
      .click();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page
      .getByRole("button", { name: `Configure ${name}`, exact: true })
      .click();
    await page.getByLabel("Show clock").uncheck();
    await page.getByRole("combobox", { name: "Photos integration" }).click();
    await page
      .getByRole("option", { name: connectionName, exact: true })
      .click();
    await page.getByRole("combobox", { name: "Photos photo source" }).click();
    await expect(
      page.getByRole("option", { name: "NASA · Planets", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("option", { name: "Wikimedia · Landscapes", exact: true })
      .click();
    const preview = page
      .getByRole("dialog")
      .frameLocator('iframe[title="Photo Hours face"]');
    await expect(preview.locator("#photo")).toBeVisible();
    await expect(preview.locator("#clock")).toBeHidden();
    await expect(preview.locator("#credit")).toBeVisible();
    await expect(preview.locator("#credit-author")).toHaveText(
      credit.attribution,
    );
    await expect(preview.locator("#credit-license")).toHaveAttribute(
      "href",
      credit.licenseUrl,
    );
    await expect(preview.locator("#credit-source")).toHaveAttribute(
      "href",
      credit.sourceUrl,
    );
    // Clearing the draft selection clears both image and provenance.
    await page.getByRole("combobox", { name: "Photos integration" }).click();
    await page
      .getByRole("option", { name: "Not connected", exact: true })
      .click();
    await expect(preview.locator("#photo")).toBeHidden();
    await expect(preview.locator("#credit")).toBeHidden();
    await page.getByRole("button", { name: "Close dialog" }).click();
    // Optional management remains available, without offering a duplicate.
    await page.getByRole("button", { name: /^Integrations/ }).click();
    const card = page.locator(".integration-card").filter({
      has: page.getByRole("heading", { name: connectionName, exact: true }),
    });
    await expect(card.getByText("Connected", { exact: true })).toBeVisible();
    await card
      .getByRole("button", { name: `Configure ${connectionName}` })
      .click();
    await expect(
      page.getByText(/Enabled by default; requires internet access/),
    ).toBeVisible();
    await expect(page.getByLabel("Enabled", { exact: true })).toBeChecked();
    await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
    await expect(page.locator('input[type="url"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page
      .getByRole("button", { name: "Add integration", exact: true })
      .click();
    await page.getByRole("combobox", { name: "Integration type" }).click();
    await expect(
      page.getByRole("option", { name: "Online backgrounds", exact: true }),
    ).toHaveCount(0);
  } finally {
    await server.app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
