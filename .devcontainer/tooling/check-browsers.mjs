import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "@playwright/test";

for (const [name, browserType] of Object.entries({
  chromium,
  firefox,
  webkit,
})) {
  const browser = await browserType.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<title>screensvr</title><canvas></canvas>");
    assert.equal(await page.title(), "screensvr");
    assert.equal(
      await page.locator("canvas").evaluate((canvas) => {
        const context = canvas.getContext("2d");
        context.fillStyle = "#123456";
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data].join(",");
      }),
      "18,52,86,255",
    );
    console.log(`${name}: headless rendering OK`);
  } finally {
    await browser.close();
  }
}
