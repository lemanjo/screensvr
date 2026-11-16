import { test, expect, type Page } from "@playwright/test";
import lightManifest from "../faces/builtin-gradient/manifest.json" with { type: "json" };
import darkManifest from "../faces/builtin-gradient-dark/manifest.json" with { type: "json" };
import type { Settings } from "../src/shared/contracts.js";

// Exercise the real sandbox and SDK without coupling face tests to admin login
// quotas or the browser's canonical spelling of timezone aliases.
async function connect(page: Page, config: Settings, timezone = "UTC") {
  await page.evaluate(
    ({ config, timezone }) =>
      new Promise<void>((resolve) => {
        const host = window as typeof window & { facePort?: MessagePort };
        host.facePort?.close();
        const channel = new MessageChannel();
        host.facePort = channel.port1;
        channel.port1.onmessage = ({ data }) => {
          if (data.type === "ready")
            channel.port1.postMessage({
              type: "update",
              config,
              context: { timezone, locale: "en-GB", name: "Preview" },
            });
          if (data.type === "applied") resolve();
        };
        document
          .querySelector("iframe")!
          .contentWindow!.postMessage({ type: "screensvr:connect" }, "*", [
            channel.port2,
          ]);
      }),
    { config, timezone },
  );
}

for (const manifest of [lightManifest, darkManifest]) {
  const defaults = Object.fromEntries(
    manifest.settings.map((setting) => [setting.key, setting.default]),
  );
  const assetUrl = `/faces/${manifest.id}/${manifest.version}/index.html`;

  test(`${manifest.name} renders and applies time, colors, and motion settings through the SDK`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.setFixedTime(new Date("2026-01-01T10:08:00Z"));
    await page.route("**/color-drift-preview", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html>
          <html><head><meta name="viewport" content="width=device-width, initial-scale=1">
          <style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block;overflow:hidden}</style>
          </head><body><iframe title="${manifest.name} face" sandbox="allow-scripts"
          src="${assetUrl}"></iframe></body></html>`,
      }),
    );
    await page.goto("/color-drift-preview");
    const face = page.frameLocator(`iframe[title="${manifest.name} face"]`);
    await expect(face.locator("#clock")).toBeVisible();
    const palette = await face.locator("html").evaluate((element) => {
      const style = getComputedStyle(element);
      return [
        "--color-one",
        "--color-two",
        "--color-three",
        "--clock-color",
      ].map((key) => style.getPropertyValue(key).trim());
    });
    expect(palette).toEqual([
      defaults.colorOne,
      defaults.colorTwo,
      defaults.colorThree,
      defaults.clockColor,
    ]);
    await connect(page, defaults);
    await expect(face.locator("#hour")).toHaveAttribute(
      "transform",
      "rotate(304 200 200)",
    );
    await expect(face.locator("#minute")).toHaveAttribute(
      "transform",
      "rotate(48 200 200)",
    );
    await expect(face.locator("#marks")).toHaveCSS("stroke-linecap", "round");
    await expect(face.locator("#marks")).toHaveCSS("stroke-width", "10px");
    await expect(face.locator("#marks line")).toHaveCount(4);
    await expect(face.locator("#clock text")).toHaveCount(0);
    await expect(face.locator("body")).toHaveText("");
    await expect(face.locator("#clock")).toHaveAttribute(
      "aria-label",
      "Current time: 10:08",
    );

    const background = face.locator(".gradient");
    const transform = () =>
      background.evaluate(
        (element) => getComputedStyle(element, "::before").transform,
      );
    const initial = await transform();
    await expect.poll(transform).not.toBe(initial);
    await page.screenshot({
      path: testInfo.outputPath("color-drift-landscape.png"),
    });
    await page.clock.setFixedTime(new Date("2026-01-01T23:59:30Z"));
    await expect(face.locator("#hour")).toHaveAttribute(
      "transform",
      "rotate(359.75 200 200)",
    );
    await expect(face.locator("#minute")).toHaveAttribute(
      "transform",
      "rotate(357 200 200)",
    );
    await page.clock.setFixedTime(new Date("2026-01-02T00:00:00Z"));
    await expect(face.locator("#hour")).toHaveAttribute(
      "transform",
      "rotate(0 200 200)",
    );
    await expect(face.locator("#minute")).toHaveAttribute(
      "transform",
      "rotate(0 200 200)",
    );

    const customized: Settings = {
      colorOne: "#6256a8",
      colorTwo: "#e9a0aa",
      colorThree: "#81cbd2",
      clockColor: "#ffffff",
      animate: false,
    };
    await connect(page, customized, "Asia/Kathmandu");
    await expect(face.locator("#hour")).toHaveAttribute(
      "transform",
      "rotate(172.5 200 200)",
    );
    await expect(face.locator("#minute")).toHaveAttribute(
      "transform",
      "rotate(270 200 200)",
    );
    await expect(face.locator("#clock")).toHaveCSS(
      "color",
      "rgb(255, 255, 255)",
    );
    const colors = await face.locator("html").evaluate((element) => {
      const style = getComputedStyle(element);
      return ["--color-one", "--color-two", "--color-three"].map((key) =>
        style.getPropertyValue(key).trim(),
      );
    });
    expect(colors).toEqual(["#6256a8", "#e9a0aa", "#81cbd2"]);
    for (const pseudo of ["::before", "::after"]) {
      expect(
        await background.evaluate(
          (element, pseudo) =>
            getComputedStyle(element, pseudo).animationPlayState,
          pseudo,
        ),
      ).toBe("paused");
    }

    await connect(page, defaults, "Asia/Kathmandu");
    for (const size of [
      { width: 390, height: 844 },
      { width: 320, height: 180 },
    ]) {
      await page.setViewportSize(size);
      const bounds = (await face.locator("#clock").boundingBox())!;
      expect(bounds.x + bounds.width / 2).toBeCloseTo(size.width / 2, 0);
      expect(bounds.y + bounds.height / 2).toBeCloseTo(size.height / 2, 0);
      expect(bounds.width).toBeLessThan(Math.min(size.width, size.height));
      await page.screenshot({
        path: testInfo.outputPath(`color-drift-${size.width}.png`),
      });
    }

    await expect(face.locator("html")).toHaveAttribute("data-animate", "true");
    expect(
      await background.evaluate(
        (element) => getComputedStyle(element, "::before").animationPlayState,
      ),
    ).toBe("running");
    expect(errors).toEqual([]);
  });

  test(`${manifest.name} respects reduced motion without hiding the clock`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(assetUrl);
    await expect(page.locator("#clock")).toHaveAttribute(
      "aria-label",
      /^Current time:/,
    );
    await expect(page.locator("#clock")).toBeVisible();
    for (const pseudo of ["::before", "::after"]) {
      expect(
        await page
          .locator(".gradient")
          .evaluate(
            (element, pseudo) =>
              getComputedStyle(element, pseudo).animationName,
            pseudo,
          ),
      ).toBe("none");
    }
  });
}
