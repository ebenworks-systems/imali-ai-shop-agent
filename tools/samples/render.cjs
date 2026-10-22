// Renders the sample invoice to the photo the demo sends: node tools/samples/render.cjs
// Needs playwright-core (PLAYWRIGHT_CORE may point at an install) and a Chrome or Chromium.
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--allow-file-access-from-files"] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  await page.goto(`file://${path.join(__dirname, "invoice.html")}`);
  await page.evaluate(() => document.fonts.ready);
  const out = path.join(__dirname, "..", "..", "public", "samples", "invoice-kudzai-wholesale.jpg");
  await page.screenshot({ path: out, type: "jpeg", quality: 84 });
  await browser.close();
  console.log(out);
})();
