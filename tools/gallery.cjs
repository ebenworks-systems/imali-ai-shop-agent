// Makes the entry's gallery pictures (3:2, 1800 x 1200), each a headline beside one card from a live run of the
// demo day, large enough to read as a thumbnail.
//   APP=http://localhost:5180 node tools/gallery.cjs
// Step one plays the demo day in the running app (live model calls) and keeps a 2x picture of each card. Step two
// sets each card beside its headline in the page's own type. Writes submission/gallery/*.png; the cards go to
// submission/work/cards/. Needs playwright-core (PLAYWRIGHT_CORE may point at an install) and Chrome (CHROME_BIN).
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");

const APP = process.env.APP || "http://localhost:5180";
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "submission", "gallery");
const CARDS = path.join(ROOT, "submission", "work", "cards");
const font = (f) => `url(data:font/woff2;base64,${fs.readFileSync(path.join(ROOT, "public", "fonts", f)).toString("base64")})`;

const SHOTS = [
  { card: "sale", eyebrow: "One line in", title: "Checked double-entry books out.", note: "“Sold 3 bread and 2 cooking oil, cash.” Nemotron 3.5 Lightning calls a typed tool; the ledger builds and checks the entry. Nothing is written until the owner taps Record." },
  { card: "photo", eyebrow: "A photo of an invoice", title: "Every line read, priced at cost.", note: "Nemotron 3.5 Super VL reads the supplier's invoice. The ledger flags a cost that moved and a new item, and adds what she owes the supplier." },
  { card: "zig", eyebrow: "Paid in ZiG", title: "The rate is read live and checked in code.", note: "Tavily search and extract read the bank's rates page. Code accepts the rate only if that exact number is printed there, dated this week, and keeps its source in the journal." },
  { card: "rand", eyebrow: "Two banks must agree", title: "One US dollar, two sources.", note: "Asked for the rand rate, the agent reads the rates pages of two Zimbabwean banks; code takes the mid rate and checks the second bank agrees within 3%." },
  { card: "close", eyebrow: "Closing the day", title: "Code counts the till. Ultra explains the gap.", note: "Nemotron 3 Ultra reads the day's records, names the likeliest reasons for the $2.00 shortfall and writes tomorrow's reorder list." },
  { card: "measured", kind: "table", eyebrow: "Measured, 23 Oct 2026", title: "81 of 81 messages passed. Median 2.2 s.", note: "Three full demo days and 18 test messages three times, on Nebius Token Factory. A whole day of nine messages cost $0.0095 at list prices." },
  { card: "architecture", kind: "full" },
];

// The measured figures per model, from submission/eval-*.json of 23 October 2026 (median per call, list prices).
const MEASURED = [
  ["Nemotron 3.5 Lightning", "reads every message, calls typed tools", "2.0 s", "$0.0003"],
  ["Nemotron 3.5 Super VL", "reads an invoice photo", "2.4 s", "$0.0008"],
  ["Nemotron 3.5 Super VL", "answers the questions that need thought (30 Oct)", "8.3 s", "$0.0016"],
  ["Nemotron 3 Ultra", "closes the day", "3.5 s", "$0.0033"],
  ["Tavily search + extract", "finds and reads the banks' rate pages", "3.0 s", "free tier"],
];

async function liveCards(browser) {
  fs.mkdirSync(CARDS, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const shot = async (name, selector) => {
    await page.waitForTimeout(700);
    const el = page.locator(selector).last();
    await el.scrollIntoViewIfNeeded();
    await el.screenshot({ path: path.join(CARDS, `${name}.png`) });
    console.log("card", name);
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
  await page.goto(`${APP}/?reset=1`, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: ".toast, body > header, .nav { display: none !important; } .thread { max-height: none !important; overflow: visible !important; }" });
  await page.evaluate(() => document.querySelectorAll(".reveal").forEach((n) => n.classList.add("in")));
  await page.waitForSelector(".live-dot.on", { timeout: 20000 });

  await ask("Sold 3 bread");
  await shot("sale", ".msg-agent");
  await recordAll();
  for (const label of ["Shona: eggs and milk", "Mai Tendai, on credit"]) {
    await ask(label);
    await recordAll();
  }
  await ask("Photo of a supplier invoice");
  await shot("photo", ".msg-agent .prop");
  await recordAll();
  await ask("Paid in ZiG");
  await shot("zig", ".msg-agent .prop");
  await recordAll();
  await ask("Rand rate today?");
  await shot("rand", ".msg-agent");
  for (const label of ["Paid electricity and transport", "Baba Farai paid back"]) {
    await ask(label);
    await recordAll();
  }
  await ask("Close the day");
  await recordAll();
  await shot("close", ".msg-agent");
  await page.close();
}

async function compose(browser) {
  fs.mkdirSync(OUT, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: 1 });
  for (const [i, s] of SHOTS.entries()) {
    const name = `${String(i + 1).padStart(2, "0")}-${s.card}.png`;
    if (s.kind === "full") {
      const svg = fs.readFileSync(path.join(ROOT, "docs", "architecture.svg"), "utf8").replace('width="1200" height="760"', 'width="1800" height="1140"');
      await page.setContent(`<!doctype html><html><body style="margin:0;width:1800px;height:1200px;background:#f7f5f0;display:grid;place-items:center">${svg}</body></html>`);
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(OUT, name) });
      console.log("picture", name);
      continue;
    }
    const right =
      s.kind === "table"
        ? `<table>${MEASURED.map(([m, job, t, c]) => `<tr><td><b>${m}</b><span>${job}</span></td><td class="n">${t}</td><td class="n c">${c}</td></tr>`).join("")}</table>`
        : `<img src="data:image/png;base64,${fs.readFileSync(path.join(CARDS, `${s.card}.png`)).toString("base64")}">`;
    await page.setContent(`<!doctype html><html><head><style>
      @font-face { font-family: Display; src: ${font("Newsreader-Display.woff2")}; }
      @font-face { font-family: Geist; font-weight: 400; src: ${font("Geist-400.woff2")}; }
      @font-face { font-family: Geist; font-weight: 600; src: ${font("Geist-600.woff2")}; }
      body { margin: 0; width: 1800px; height: 1200px; background: #f2f0eb; font-family: Geist, sans-serif; color: #1e3932; display: grid; grid-template-columns: 700px 1fr; gap: 70px; align-items: center; padding: 0 90px; box-sizing: border-box; overflow: hidden; }
      .eyebrow { font-weight: 600; font-size: 28px; letter-spacing: .14em; text-transform: uppercase; color: #a07b3b; }
      h1 { margin: 26px 0 0; font: 400 96px/1.02 Display, Georgia, serif; letter-spacing: -.025em; }
      p { margin: 36px 0 0; font-size: 31px; line-height: 1.45; color: #4b5a54; }
      .foot { margin-top: 44px; font-size: 22px; color: #8a938e; }
      .shot { display: grid; place-items: center; height: 1060px; }
      table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 28px; overflow: hidden; box-shadow: 0 40px 90px -40px rgba(30,57,50,.35), 0 0 0 1px rgba(30,57,50,.08); }
      td { padding: 30px 34px; border-top: 1px solid #ece8de; font-size: 30px; vertical-align: middle; }
      tr:first-child td { border-top: 0; }
      td b { display: block; font-weight: 600; color: #1e3932; }
      td span { display: block; margin-top: 6px; font-size: 24px; color: #6b766f; }
      td.n { text-align: right; white-space: nowrap; font-weight: 600; font-variant-numeric: tabular-nums; color: #00754a; }
      td.c { color: #1e3932; }
      .shot img { width: 100%; max-height: 1060px; object-fit: contain; object-position: center; border-radius: 28px; box-shadow: 0 40px 90px -40px rgba(30,57,50,.35), 0 0 0 1px rgba(30,57,50,.08); background: #fff; }
    </style></head><body>
      <div><div class="eyebrow">${s.eyebrow}</div><h1>${s.title}</h1><p>${s.note}</p><div class="foot">Imali AI shop agent · Rudo's shop is invented for this demo</div></div>
      <div class="shot">${right}</div>
    </body></html>`);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(OUT, name) });
    console.log("picture", name);
  }
  await page.close();
}

// The entry's thumbnail (3:2) and the film's (16:9). The project gallery shows the first about 300 pixels wide, so the
// promise is set in very large type beside two live cards; the title and pitch print under the tile already.
async function thumbnail(browser, { width, height, file, top, cardTop }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const card = (name) => `data:image/png;base64,${fs.readFileSync(path.join(CARDS, `${name}.png`)).toString("base64")}`;
  await page.setContent(`<!doctype html><html><head><style>
    @font-face { font-family: Display; src: ${font("Newsreader-Display.woff2")}; }
    @font-face { font-family: Geist; font-weight: 600; src: ${font("Geist-600.woff2")}; }
    body { margin: 0; width: ${width}px; height: ${height}px; background: #f2f0eb; font-family: Geist, sans-serif; color: #1e3932; position: relative; overflow: hidden; }
    .copy { position: absolute; left: 100px; top: ${top}px; width: 1000px; }
    .eyebrow { font-weight: 600; font-size: 44px; letter-spacing: .12em; text-transform: uppercase; color: #a07b3b; }
    h1 { margin: 34px 0 0; font: 400 172px/.96 Display, Georgia, serif; letter-spacing: -.03em; }
    .fig { margin-top: 56px; font-weight: 600; font-size: 50px; color: #00754a; }
    .fig span { display: block; margin-top: 10px; font-size: 30px; color: #6b766f; letter-spacing: .02em; }
    img { position: absolute; width: 700px; border-radius: 30px; background: #fff; box-shadow: 0 50px 100px -40px rgba(30,57,50,.45), 0 0 0 1px rgba(30,57,50,.08); }
    .back { right: -150px; top: 80px; transform: rotate(4deg); }
    .front { right: 50px; top: ${cardTop}px; transform: rotate(-2deg); }
  </style></head><body>
    <div class="copy"><div class="eyebrow">NVIDIA Nemotron · Tavily</div><h1>One message in. Checked books out.</h1>
      <div class="fig">Median reply 2.2 s<span>Measured on Nebius Token Factory, 23 Oct 2026</span></div></div>
    <img class="back" src="${card("zig")}"><img class="front" src="${card("sale")}">
  </body></html>`);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, file) });
  console.log("picture", file);
  await page.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome" });
  if (!process.env.COMPOSE_ONLY) await liveCards(browser);
  await compose(browser);
  await thumbnail(browser, { width: 1800, height: 1200, file: "thumbnail.png", top: 150, cardTop: 520 });
  await thumbnail(browser, { width: 1920, height: 1080, file: "film-thumbnail.png", top: 110, cardTop: 450 });
  await browser.close();
})();
