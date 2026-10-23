// Records the demo film from the running app, with live calls to Nebius Token Factory. Every scene lasts at least as
// long as its narration (submission/work/takes/lengths.json from narrate.py) and waits for the real answer.
//   APP=http://localhost:5180 node tools/video/record.cjs
// Writes submission/work/film-raw.mp4 and film-raw.events.json (scene start times) for compose.py.
const fs = require("fs");
const path = require("path");
const { record, hand } = require("./capture.cjs");

const APP = process.env.APP || "http://localhost:5180";
const ROOT = path.resolve(__dirname, "..", "..");
const WORK = path.join(ROOT, "submission", "work");
const LINES = require("./narration.json");
const LENGTHS = JSON.parse(fs.readFileSync(path.join(WORK, "takes", "lengths.json"), "utf8"));
const GAP = 0.35;

// The opening card: the problem before the product, in the page's own type and colours.
const OPEN_CARD = `(() => {
  const d = document.createElement("div");
  d.id = "open-card";
  d.style.cssText = "position:fixed;inset:0;z-index:2147483640;display:grid;place-items:center;background:#f2f0eb;transition:opacity .9s cubic-bezier(.32,.72,0,1)";
  d.innerHTML = \`<div style="max-width:1040px;padding:0 64px">
    <p style="margin:0;font:600 15px/1 Geist,sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#a07b3b">Harare, closing time</p>
    <p style="margin:26px 0 0;font:400 96px/1 'Newsreader Display',Georgia,serif;letter-spacing:-.03em;color:#1e3932">Every sale goes into<br>a paper book.</p>
    <p style="margin:30px 0 0;font:italic 400 46px/1.15 'Newsreader Display',Georgia,serif;color:#00754a">What did I make? Who owes me?<br>Why is the till short?</p>
    <p style="margin:44px 0 0;font:400 16px/1.4 Geist,sans-serif;color:rgba(35,32,28,.55)">Rudo and her shop are invented for this demo.</p>
  </div>\`;
  document.body.append(d);
})()`;
const OPEN_CARD_OUT = `(() => { const d = document.getElementById("open-card"); if (d) { d.style.opacity = "0"; setTimeout(() => d.remove(), 1000); } })()`;

// The closing card, drawn over the page in the page's own type and colours.
const END_CARD = `(() => {
  const d = document.createElement("div");
  d.style.cssText = "position:fixed;inset:0;z-index:2147483640;display:grid;place-items:center;background:#f2f0eb;opacity:0;transition:opacity .9s cubic-bezier(.32,.72,0,1)";
  d.innerHTML = \`<div style="text-align:center;max-width:980px;padding:0 40px">
    <p style="margin:0;font:400 104px/1 'Newsreader Display',Georgia,serif;letter-spacing:-.03em;color:#1e3932">Imali AI</p>
    <p style="margin:14px 0 0;font:italic 400 44px/1.1 'Newsreader Display',Georgia,serif;color:#00754a">Records you own.</p>
    <p style="margin:34px 0 0;font:500 20px/1.5 Geist,sans-serif;color:rgba(35,32,28,.72)">Nemotron 3.5 Lightning · Nemotron 3.5 Super VL · Nemotron 3 Super · Nemotron 3 Ultra<br>served by Nebius Token Factory</p>
    <div style="margin:40px auto 0;display:inline-grid;gap:10px;text-align:left;font:400 20px/1.4 Geist,sans-serif;color:#23201c">
      <span><span style="display:inline-block;width:92px;color:rgba(35,32,28,.55)">Try it</span>imali-ai-shop-agent.vercel.app</span>
      <span><span style="display:inline-block;width:92px;color:rgba(35,32,28,.55)">Code</span>gitlab.com/ebenworks-systems/imali-ai-shop-agent</span>
    </div>
    <p style="margin:36px 0 0;font:500 18px/1.5 Geist,sans-serif;color:#1e3932">Measured on Token Factory, 23 October 2026: 81 of 81 test messages passed their checks,<br>median reply 1.9 s, about one cent for a whole demo day.</p>
    <p style="margin:26px 0 0;font:400 16px/1.4 Geist,sans-serif;color:rgba(35,32,28,.55)">An Ebenworks product. The demo shop, names and figures are invented.</p>
  </div>\`;
  document.body.append(d);
  requestAnimationFrame(() => requestAnimationFrame(() => (d.style.opacity = "1")));
})()`;

// Seconds of speech in a scene, with the gaps compose.py puts between its lines.
const speech = (scene) => {
  const lines = LINES.filter((l) => l.scene === scene);
  return lines.reduce((a, l) => a + LENGTHS[l.id], 0) + GAP * (lines.length - 1) + 0.6;
};

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const result = await record({
    name: "film-raw",
    outDir: WORK,
    viewport: { width: 1280, height: 720 },
    scale: 1.5,
    start: `${APP}/?reset=1`,
    setup: async ({ page }) => {
      await page.waitForSelector(".live-dot.on", { timeout: 20000 });
      await page.evaluate(() => document.querySelectorAll(".reveal").forEach((n) => n.classList.add("in")));
      await page.evaluate(() => scrollTo(0, 0));
      await page.evaluate(OPEN_CARD);
      await page.waitForTimeout(800);
    },
    script: async ({ page, mark, sleep }) => {
      const h = hand(page);
      const t0 = Date.now();
      const now = () => (Date.now() - t0) / 1000;
      let sceneStart = 0;
      let current = null;
      const scene = async (name) => {
        if (current) {
          const left = sceneStart + speech(current) - now();
          if (left > 0) await sleep(left * 1000);
          await sleep(500);
        }
        current = name;
        sceneStart = now();
        mark(name);
      };
      const answered = async () => {
        await page.waitForFunction(() => !document.querySelector(".thinking"), null, { timeout: 90000, polling: 200 });
        await sleep(700);
      };
      const ask = async (label) => {
        await h.click(`.suggest button:has-text("${label}")`);
        await sleep(400);
        await answered();
      };
      const recordAll = async () => {
        const n = await page.locator(".msg-agent:last-child .btn-primary").count();
        for (let i = 0; i < n; i += 1) {
          await h.click(".msg-agent:last-child .btn-primary");
          await sleep(900);
        }
      };

      await scene("open");
      await sleep((speech("open") - 0.8) * 1000);
      await page.evaluate(OPEN_CARD_OUT);

      await scene("hero");
      await sleep(Math.max(0, speech("hero") - 2.4) * 1000);
      await h.scrollToEl("#demo", { offset: 84, ms: 1800 });

      await scene("sale");
      await sleep(1800);
      await ask("Sold 3 bread");
      await scene("record");
      await recordAll();

      await scene("shona");
      await ask("Shona: eggs and milk");
      await recordAll();

      await scene("credit");
      await ask("Mai Tendai, on credit");
      await recordAll();

      await scene("photo");
      await ask("Photo of a supplier invoice");
      await sleep(1500);
      await recordAll();

      await scene("zig");
      await ask("Paid in ZiG");
      await sleep(1200);
      await recordAll();

      await scene("rand");
      await ask("Rand rate today?");

      await scene("costs");
      await ask("Paid electricity and transport");
      await recordAll();
      await ask("Baba Farai paid back");
      await recordAll();

      await scene("ask");
      await ask("What should I restock?");

      await scene("close");
      await ask("Close the day");
      await sleep(2500);
      await recordAll();

      await scene("route");
      await h.scrollToEl(".card-trace", { offset: 300, ms: 1600 });
      await sleep(4200);
      await h.scrollToEl(".card-today", { offset: 92, ms: 1400 });

      await scene("end");
      await page.evaluate(END_CARD);
      await page.mouse.move(-20, -20);
      const left = sceneStart + speech("end") + 2.5 - now();
      if (left > 0) await sleep(left * 1000);
    },
  });
  console.log(`${result.out}: ${result.seconds.toFixed(1)} s, ${result.width}x${result.height}`);
  for (const e of result.events) console.log(`  ${e.label.padEnd(8)} ${e.t.toFixed(1)} s`);
})();
