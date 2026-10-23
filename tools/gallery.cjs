// Takes the gallery pictures for the entry (3:2, 1800 x 1200) from the running app, with live model calls.
//   APP=http://localhost:5180 node tools/gallery.cjs        (HERO_ONLY=1 takes the first picture alone, with no model calls)
// Writes submission/gallery/*.png. Needs playwright-core (PLAYWRIGHT_CORE may point at an install) and Chrome.
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");

const APP = process.env.APP || "http://localhost:5180";
const OUT = path.resolve(__dirname, "..", "submission", "gallery");

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome" });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1.5 });
  const shot = async (name) => {
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log(name);
  };
  const ask = async (label) => {
    await page.click(`.suggest button:has-text("${label}")`);
    await page.waitForTimeout(300);
    await page.waitForFunction(() => !document.querySelector(".thinking"), null, { timeout: 120000, polling: 200 });
    await page.waitForTimeout(500);
  };
  const recordAll = async () => {
    while (await page.locator(".msg-agent:last-child .btn-primary").count()) {
      await page.click(".msg-agent:last-child .btn-primary");
      await page.waitForTimeout(400);
    }
  };
  const toDemo = () => page.evaluate(() => document.querySelector("#demo").scrollIntoView({ block: "start" }));

  await page.goto(`${APP}/?reset=1`, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: ".toast { display: none !important; }" });
  await page.evaluate(() => document.querySelectorAll(".reveal").forEach((n) => n.classList.add("in")));
  await page.waitForSelector(".live-dot.on", { timeout: 20000 });
  await shot("01-hero");
  if (process.env.HERO_ONLY) return browser.close();

  await toDemo();
  for (const label of ["Sold 3 bread", "Shona: eggs and milk", "Mai Tendai, on credit"]) {
    await ask(label);
    await recordAll();
  }
  await ask("Photo of a supplier invoice");
  await toDemo();
  await shot("02-invoice-photo");
  await recordAll();
  await ask("Paid in ZiG");
  await toDemo();
  await shot("03-paid-in-zig");
  await recordAll();
  for (const label of ["Paid electricity and transport", "Baba Farai paid back"]) {
    await ask(label);
    await recordAll();
  }
  await ask("What should I restock?");
  await toDemo();
  await shot("04-restock-advice");
  await ask("Close the day");
  await recordAll();
  await toDemo();
  await shot("05-close-the-day");
  await page.evaluate(() => {
    const el = document.querySelector(".card-journal");
    scrollTo(0, el.getBoundingClientRect().top + scrollY - 92);
  });
  await shot("06-journal-and-route");
  await page.evaluate(() => document.querySelector("#how").scrollIntoView({ block: "start" }));
  await shot("07-how-it-works");
  await browser.close();
})();
