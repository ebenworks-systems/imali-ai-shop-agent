// The agent. Nemotron 3.5 Lightning reads every message and calls tools; the ledger turns each call into a
// checked double-entry proposal; Nemotron 3.5 Super VL reads photos; Nemotron 3 Super answers the
// questions that need thought and takes over when Lightning's tool calls keep failing; Nemotron 3 Ultra
// closes the day. Nothing reaches the books until the owner confirms in the app.

import { currencyCode } from "./rates.js";
import {
  BUILDERS,
  applyEntry,
  balances,
  buildCashCount,
  daySummary,
  findItem,
  localItemWords,
  mentionsItem,
  money,
  partyBalances,
  snapshotForModel,
  stockReport,
  unitsSold,
} from "../public/js/ledger.js";

const PAYMENT = { type: "string", enum: ["cash", "mobile_money", "credit"] };
const METHOD = { type: "string", enum: ["cash", "mobile_money"] };
const fn = (name, description, properties, required) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });

export const TOOLS = [
  fn(
    "record_sale",
    "Record one sale to a customer. Leave unit_price out to use the catalogue price.",
    {
      items: {
        type: "array",
        items: { type: "object", properties: { item: { type: "string", description: "catalogue id" }, qty: { type: "number" }, unit_price: { type: "number" } }, required: ["item", "qty"] },
      },
      payment: PAYMENT,
      customer: { type: "string", description: "needed when payment is credit" },
      amount_received: { type: "number", description: "only when the owner states the total received in US dollars" },
      paid_currency: { type: "string", description: "when the customer paid in another currency: ZiG, ZAR (rand), BWP or ZMW" },
      paid_amount: { type: "number", description: "the amount paid in that currency" },
      rate: { type: "number", description: "only when the owner states the rate used: units of that currency per US dollar" },
    },
    ["items", "payment"],
  ),
  fn(
    "record_stock_in",
    "Record stock received from a supplier, with what each unit cost.",
    {
      supplier: { type: "string" },
      items: {
        type: "array",
        items: { type: "object", properties: { item: { type: "string", description: "catalogue id, or the name on the invoice for a new item" }, qty: { type: "number" }, unit_cost: { type: "number" } }, required: ["item", "qty", "unit_cost"] },
      },
      paid: { type: "string", enum: ["cash", "mobile_money", "on_account"] },
      total: { type: "number", description: "the total printed on the invoice, if there is one" },
    },
    ["supplier", "items", "paid"],
  ),
  fn("record_expense", "Record one running cost paid out of the business (rent, electricity, transport, wages).", { category: { type: "string" }, amount: { type: "number" }, payment: METHOD }, ["category", "amount", "payment"]),
  fn("record_customer_payment", "Record a customer paying back what they owe.", { customer: { type: "string" }, amount: { type: "number" }, method: METHOD }, ["customer", "amount", "method"]),
  fn("record_supplier_payment", "Record paying a supplier what the shop owes them.", { supplier: { type: "string" }, amount: { type: "number" }, method: METHOD }, ["supplier", "amount", "method"]),
  fn("record_owner_withdrawal", "Record money the owner took out of the business for themselves.", { amount: { type: "number" }, method: METHOD, note: { type: "string" } }, ["amount", "method"]),
  fn("set_price", "Change the selling price of one catalogue item.", { item: { type: "string" }, sell_price: { type: "number" } }, ["item", "sell_price"]),
  fn("get_exchange_rate", "Look up today's official exchange rate of ZiG, rand, pula or kwacha to the US dollar, with its source.", { currency: { type: "string" } }, ["currency"]),
  fn("get_figures", "Read figures from the books: today's sales and profit, stock levels, who owes the shop, or money on hand.", { about: { type: "string", enum: ["today", "stock", "who_owes", "money"] } }, ["about"]),
  fn("ask_analyst", "Pass a question that needs thought (what to restock, what sells slowly, why profit moved, pricing advice) to a stronger model that reads the whole book.", { question: { type: "string" } }, ["question"]),
  fn("close_day", "Close the day: compare the cash the owner counted with what the books expect, and write the day's summary.", { counted_cash: { type: "number" } }, ["counted_cash"]),
  fn("reply", "Answer the owner without recording anything: a greeting, a question back to the owner, or an answer that needs no figures from the books.", { text: { type: "string" } }, ["text"]),
];

const WRITE_TOOLS = new Set(Object.keys(BUILDERS));
const LIMITS = { message: 600, historyItems: 6, historyText: 600, imageBytes: 3_500_000, journal: 600, booksBytes: 400_000 };

export function routerPrompt(snapshot) {
  const { shop } = snapshot;
  return [
    `You are the agent inside Imali AI. You keep the books for ${shop.owner}, who runs ${shop.name} in ${shop.place}. Money is in US dollars. Today is ${snapshot.today}.`,
    "Turn each message into the right records with the tools, then reply in one to three short sentences. Every message starts with a tool call: records are made only through the record tools, never by saying so, and a message that needs no record or figure gets the reply tool.",
    "",
    "Rules:",
    "- One tool call per transaction. A message can hold several transactions: two costs paid are two record_expense calls. Call only the tools the message needs; look up figures or rates only when the owner asks or pays in another currency.",
    "- Use catalogue ids for items, and record every item the message names. Owners write in English, chiShona, isiNdebele or a mix; also_called lists the local names (mazai is eggs, mukaka is milk, chingwa is bread, sipo is soap, munyu is salt).",
    "- Words to know. chiShona: ndatengesa = I sold, ndatenga = I bought, ndabhadhara = I paid, ndabhadharwa = I was paid, chikwereti = on credit, mari = money. isiNdebele: ngithengise = I sold, ngithenge = I bought, isikwelede = on credit, imali = money. Both join 'and' to the next word: nemukaka = ne + mukaka (and milk), nemunyu = ne + munyu (and salt), lamaqanda = la + amaqanda (and eggs).",
    "- Never invent a price, a quantity or how a customer paid. Leave unit_price out to use the catalogue price. Pass amount_received only when the owner states the total they received. If a sale does not say cash, mobile money or credit, record nothing for it and ask how the customer paid.",
    "- Mobile money covers EcoCash, OneMoney, InnBucks and bank transfers. On credit, chikwereti, isikwelede or 'will pay later' means payment credit, with the customer's name.",
    "- A photo reading arrives as JSON after the owner's words. A supplier invoice or delivery note becomes one record_stock_in with each line's unit cost. Take how it was paid from the owner's words first, then the invoice; if neither says, ask.",
    "- Questions about today's figures, stock, money on hand or who owes: call get_figures and answer with its numbers.",
    "- Advice or analysis (what to restock, what sells slowly, why, how to price): call ask_analyst.",
    "- Closing the day or a till count: call close_day with the counted cash.",
    "- A customer who paid in ZiG, rand, pula or kwacha: pass paid_currency and paid_amount on record_sale; the system looks up today's official rate. Pass rate only when the owner says which rate was used.",
    "- Record only what the owner's latest message says. Earlier messages are there to explain short answers; never record them again.",
    "- When a tool answers with a question, ask the owner that question and record nothing else for that transaction.",
    "- Reply in the language the owner wrote in. Plain words, no markdown, no emoji, item names rather than ids. Say what is ready to record and any warning a tool gave. Nothing is in the books until the owner taps Record, so never say done, saved or recorded. Do not list stock or figures the owner did not ask for.",
    "",
    "The books right now:",
    JSON.stringify(snapshot),
  ].join("\n");
}

export function stripThinking(text) {
  return String(text ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<tool_call>[\s\S]*$/i, "")
    .replace(/\*\*/g, "")
    .trim();
}

// Some deployments return tool calls as text in the content. Read those too.
export function toolCallsOf(message) {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) return message.tool_calls;
  const out = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let m;
  while ((m = re.exec(String(message.content ?? "")))) {
    const xml = /^<function=([\w-]+)>([\s\S]*?)(?:<\/function>|$)/.exec(m[1]);
    if (xml) {
      const params = Object.fromEntries([...xml[2].matchAll(/<parameter=([\w-]+)>\s*([\s\S]*?)\s*<\/parameter>/g)].map(([, k, v]) => [k, v]));
      out.push({ id: `text-${out.length}`, type: "function", function: { name: xml[1], arguments: JSON.stringify(params) } });
      continue;
    }
    try {
      const parsed = JSON.parse(m[1]);
      out.push({ id: `text-${out.length}`, type: "function", function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments ?? parsed.parameters ?? {}) } });
    } catch {
      out.push({ id: `text-${out.length}`, type: "function", function: { name: "unreadable", arguments: "{}" } });
    }
  }
  return out;
}

// Words that say how a customer paid, in English, chiShona and isiNdebele. A sale whose message has none of them is
// asked about instead of recorded, so a model's guess never lands in the till.
const PAYMENT_WORDS = /(cash|mari|imali|mobile|eco ?cash|one ?money|innbucks|swipe|card|transfer|bank|credit|chikwereti|isikwelede|later|owe|tab|paid|pay|bhadhar|bhadal|zig|zwg|rand|usd|\$)/i;

// Currencies the rate lookup knows, as an owner would write them.
const CURRENCY_WORDS = /\b(zig|zwg|zimbabwe gold|bond|rand|rands|zar|pula|bwp|kwacha|zmw|exchange rate|rate)\b/i;

export function saysHowPaid(text) {
  return PAYMENT_WORDS.test(String(text || ""));
}

export function numbersIn(text) {
  return new Set((String(text || "").match(/\d+(?:[.,]\d+)?/g) || []).map((n) => Number(n.replace(",", "."))));
}

function names(text, name) {
  const first = String(name || "").toLowerCase().split(/\s+/).find((w) => w.length > 2 && !["mai", "baba", "mr", "mrs", "the"].includes(w));
  return Boolean(first) && String(text || "").toLowerCase().includes(first);
}

// Records come only from the owner's latest message (and its photo). A model that reaches back into the history,
// or fills in a number the owner never gave, is sent back with the reason.
export function fromLatestMessage(name, args, message, photo, books) {
  const nums = numbersIn(message);
  const said = (n) => n === undefined || n === null || nums.has(Number(n));
  if (name === "record_customer_payment" && !names(message, args.customer)) return `${args.customer || "That customer"} is not named in the owner's latest message. Record only what it says.`;
  if (name === "record_supplier_payment" && !names(message, args.supplier)) return `${args.supplier || "That supplier"} is not named in the owner's latest message. Record only what it says.`;
  if (name === "record_sale" && args.payment === "credit" && args.customer && !names(message, args.customer)) return `${args.customer} is not named in the owner's latest message. Ask who took it on credit.`;
  if (["record_expense", "record_customer_payment", "record_supplier_payment", "record_owner_withdrawal"].includes(name) && !said(args.amount)) return "That amount is not in the owner's latest message. Use the owner's own figure or ask.";
  if (name === "record_stock_in" && !photo && !names(message, args.supplier) && !(args.items || []).some((it) => said(it.unit_cost))) return "This stock is not in the owner's latest message. Record only what it says.";
  if (name === "set_price" && (!said(args.sell_price ?? args.price) || (books && !mentionsItem(findItem(books, args.item), message)))) return "The owner's latest message does not ask for this price change. Change a price only when the owner names the item and the new price.";
  if (["record_sale", "record_stock_in"].includes(name) && !photo && books) {
    const missing = (args.items || []).map((it) => findItem(books, it.item)).find((item) => item && !mentionsItem(item, message));
    if (missing) return `${missing.name} is not in the owner's latest message. Record only the items it names; if it names an item the shop does not stock, ask about it.`;
  }
  return null;
}

// Every number in a reply about new records must come from the owner's words or a tool's answer. A reply that
// adds its own totals is replaced by a confirmation written from the checked records.
function parses(json) {
  try {
    JSON.parse(json || "{}");
    return true;
  } catch {
    return false;
  }
}

export function figuresGrounded(reply, grounds) {
  const known = new Set(grounds.flatMap((g) => [...numbersIn(g)]));
  return [...numbersIn(reply)].every((n) => known.has(n));
}

export function rateAnswer(r) {
  const kind = r.kind === "official mid" ? "the mid rate" : r.kind === "midpoint of buy and sell" ? "the midpoint of the buying and selling rates" : "the rate";
  const other = (r.sources || []).find((x) => x.host !== r.source);
  return `One US dollar is ${r.unitsPerUsd} ${r.currency}: ${kind} on ${r.source}${r.asOf ? `, dated ${r.asOf}` : ""}${other ? `, and ${other.host} agrees at ${other.unitsPerUsd}` : ""}.`;
}

export function confirmation(proposals, questions = []) {
  const lines = proposals.map((p) => `${p.summary}${p.amount && !/\$/.test(p.summary) ? `, ${money(p.amount)}` : ""}.`);
  const warnings = proposals.flatMap((p) => p.warnings || []);
  return [...lines, ...warnings, ...questions.slice(0, 1), "Tap Record to add it."].join(" ");
}

function normaliseArgs(name, args) {
  const a = { ...args };
  for (const k of ["payment", "method", "paid"]) if (a[k] === "mobile_money") a[k] = "mobile";
  if (name === "record_stock_in" && a.paid === "on_account") a.paid = "credit";
  return a;
}

function hinted(books, words) {
  const local = localItemWords(books, words.split("\n\nPhoto reading")[0]);
  return local.length ? `${words}\n\n(Local item names in this message: ${local.join("; ")}.)` : words;
}

export function figures(books, about) {
  const s = daySummary(books);
  const b = balances(books);
  if (about === "stock")
    return { stock: stockReport(books).map((r) => ({ item: r.name, in_stock: r.qty, reorder_at: r.reorderAt, low: r.low })) };
  if (about === "who_owes")
    return {
      customers_owe_you: Object.entries(partyBalances(books, "debtors")).filter(([, v]) => v > 0).map(([name, v]) => ({ name, owes: money(v) })),
      you_owe_suppliers: Object.entries(partyBalances(books, "creditors")).filter(([, v]) => v < 0).map(([name, v]) => ({ name, owed: money(-v) })),
    };
  if (about === "money") return { cash_in_till: money(b.cash), mobile_money: money(b.mobile), customers_owe_you: money(b.debtors), you_owe_suppliers: money(-b.creditors) };
  return {
    day: s.day,
    sales: money(s.sales),
    paid_in_cash: money(s.cash),
    paid_by_mobile_money: money(s.mobile),
    on_credit: money(s.credit),
    cost_of_what_was_sold: money(s.cogs),
    gross_profit: money(s.grossProfit),
    running_costs: money(s.expenses),
    profit_after_costs: money(s.net),
    collected_from_customers: money(s.collected),
    records_today: s.count,
  };
}

function bookForAnalyst(books) {
  const sold = unitsSold(books, 7);
  return {
    ...snapshotForModel(books),
    units_sold_last_7_days: Object.fromEntries(Object.entries(sold).map(([id, q]) => [books.items[id]?.name ?? id, q])),
    todays_records: books.journal.filter((e) => e.kind !== "opening" && e.at.startsWith(books.today)).map((e) => ({ at: e.at.slice(11, 16), what: e.memo, amount: e.amount ? money(e.amount) : undefined })),
  };
}

async function askAnalyst({ chat, models, books, question, ownerWords }) {
  const res = await chat({
    model: models.analyst,
    purpose: "analyst",
    maxTokens: 4000,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content:
          "You are a careful small-business adviser inside Imali AI. Answer the owner's question from the books given, with real item names and numbers from them. Be specific and practical. At most 110 words, plain sentences, no markdown, no emoji. Reply in the language of the owner's own words.",
      },
      { role: "user", content: `Owner's words: ${ownerWords}\nQuestion: ${question}\nBooks: ${JSON.stringify(bookForAnalyst(books))}` },
    ],
  });
  return { text: stripThinking(res.message.content), trace: res.trace };
}

async function closeDay({ chat, models, books, counted, ownerWords }) {
  const count = buildCashCount(books, { counted_cash: counted });
  if (!count.ok) return { question: count.question };
  const s = daySummary(books);
  const facts = {
    till: { expected: money(count.expected), counted: money(count.counted), difference: money(count.diff), result: count.diff === 0 ? "exact" : count.diff < 0 ? "short" : "over" },
    today: figures(books, "today"),
    low_stock: stockReport(books).filter((r) => r.low).map((r) => `${r.name}: ${r.qty} left`),
    records: bookForAnalyst(books).todays_records,
  };
  const res = await chat({
    model: models.closer,
    purpose: "closer",
    maxTokens: 5000,
    temperature: 0.2,
    timeout: 55_000,
    messages: [
      {
        role: "system",
        content:
          "You close a small shop's day inside Imali AI. From the facts given: say in one sentence how the day went (sales and profit after costs). If the till is short or over, give the two most likely reasons from today's records (for example a credit sale or mobile money payment entered as cash, change given wrongly, a cost paid from the till and not recorded) and say what to check. Then list what to reorder tomorrow. At most 120 words, plain sentences, no markdown, no emoji. Reply in the language of the owner's own words.",
      },
      { role: "user", content: `Owner's words: ${ownerWords}\nFacts: ${JSON.stringify(facts)}` },
    ],
  });
  return { text: stripThinking(res.message.content), trace: res.trace, count, summary: s };
}

export async function readPhoto({ chat, models, image }) {
  const res = await chat({
    model: models.vision,
    purpose: "photo reader",
    maxTokens: 1200,
    temperature: 0,
    json: true,
    messages: [
      {
        role: "system",
        content:
          'You read photos for a small shop\'s stock book. The photo may be a supplier invoice, a delivery note, a handwritten stock list or a till slip. Reply with JSON only, with exactly these keys: {"kind":"invoice|delivery_note|stock_list|receipt|other","supplier":string|null,"date":string|null,"items":[{"name":string,"qty":number,"unit_cost":number|null,"line_total":number|null}],"total":number|null,"paid":"cash|mobile_money|on_account|unknown","notes":string}. Copy numbers exactly as printed. Use null for anything you cannot read.',
      },
      { role: "user", content: [{ type: "text", text: "Read this photo." }, { type: "image_url", image_url: { url: image } }] },
    ],
  });
  const text = stripThinking(res.message.content).replace(/^```(?:json)?|```$/g, "").trim();
  let reading;
  try {
    reading = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    reading = null;
  }
  if (!reading || !Array.isArray(reading.items)) return { reading: null, trace: res.trace };
  reading.items = reading.items
    .filter((it) => it && typeof it.name === "string")
    .slice(0, 40)
    .map((it) => ({ name: it.name.slice(0, 60), qty: Number(it.qty) || null, unit_cost: it.unit_cost === null ? null : Number(it.unit_cost) || null, line_total: it.line_total === null ? null : Number(it.line_total) || null }));
  return { reading, trace: res.trace };
}

export function validateRequest(body) {
  if (!body || typeof body !== "object") return "Send a JSON body.";
  const { message = "", image, books, history = [] } = body;
  if (typeof message !== "string" || message.length > LIMITS.message) return `Keep the message under ${LIMITS.message} characters.`;
  if (!message.trim() && !image) return "Type a message or add a photo.";
  if (image !== undefined && (typeof image !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > LIMITS.imageBytes)) return "The photo must be a JPEG, PNG or WebP under about 2.5 MB.";
  if (!Array.isArray(history) || history.length > 20) return "History is malformed.";
  for (const h of history) if (!h || !["user", "assistant"].includes(h.role) || typeof h.content !== "string") return "History is malformed.";
  if (!books || typeof books !== "object" || !books.items || !Array.isArray(books.journal) || !books.shop) return "The books are missing.";
  if (books.journal.length > LIMITS.journal || JSON.stringify(books).length > LIMITS.booksBytes) return "The demo books are full. Reset the demo to start again.";
  return null;
}

export async function runAgent({ chat, models, books, message = "", image, history = [], now = new Date().toISOString(), rates }) {
  const trace = [];
  const proposals = [];
  const seen = new Set();
  let working = { ...structuredClone(books), now };
  let photo;
  let words = message.trim();

  if (image) {
    const read = await readPhoto({ chat, models, image });
    trace.push(read.trace);
    photo = read.reading;
    words = `${words || "Here is a photo."}\n\nPhoto reading from ${models.vision.label} (JSON): ${photo ? JSON.stringify(photo) : '{"error":"the photo could not be read"}'}`;
  }

  const messages = [
    { role: "system", content: routerPrompt(snapshotForModel(working)) },
    ...history.slice(-LIMITS.historyItems).map((h) => ({ role: h.role, content: h.content.slice(0, LIMITS.historyText) })),
    { role: "user", content: hinted(working, words) },
  ];

  let model = models.router;
  let failures = 0;
  const questions = [];
  const grounds = [words];
  let escalated = false;
  const lookups = [];
  const done = (reply, extra = {}) => {
    // A rate already shown on a record's card is not shown twice.
    const onCards = new Set(proposals.filter((p) => p.rate).map((p) => p.rate.currency));
    const shown = lookups.filter((l) => !onCards.has(l.currency));
    return { reply, proposals, trace, photo, escalated, ...(shown.length ? { lookups: shown } : {}), ...extra };
  };
  // The reply that reaches the owner: a question from the ledger is never dropped, and a reply about new records
  // that brings figures of its own is replaced by a confirmation written from the checked records.
  const finish = (text) => {
    // A rate question gets its answer from the checked lookup, not from the model's wording.
    if (!proposals.length && lookups.length) return done(lookups.map(rateAnswer).join(" "));
    let out = text;
    if (questions.length && !/\?/.test(out)) out = proposals.length ? `${out} ${questions[0]}` : questions[0];
    if (proposals.length && !figuresGrounded(out, grounds)) out = confirmation(proposals, questions);
    return done(out);
  };

  for (let round = 0; round < 6; round += 1) {
    // The first call must use a tool, so a model that has seen earlier replies such as "Recorded ..." in the history
    // cannot answer as if it had recorded something without calling a record tool.
    const res = await chat({ model, purpose: escalated ? "router, retried on Super" : "router", messages, tools: TOOLS, toolChoice: round === 0 ? "required" : "auto", maxTokens: escalated ? 4000 : 450, temperature: 0.1 });
    trace.push(res.trace);
    // Lightning sometimes repeats its calls until it reaches the token limit (41 calls for one sale on 23 Oct 2026).
    // Each distinct call is kept once, with the first reply only; a call cut off at the limit is dropped.
    const truncated = res.finish === "length";
    const distinct = new Set();
    let replied = false;
    const calls = toolCallsOf(res.message).filter((c) => {
      const name = c.function?.name;
      if (truncated && !parses(c.function?.arguments)) return false;
      if (name === "reply") return !replied && (replied = true);
      const key = `${name}:${c.function?.arguments}`;
      return !distinct.has(key) && Boolean(distinct.add(key));
    });
    if (truncated && !calls.length) {
      failures += 1;
      messages.push({ role: "user", content: "Your answer was cut off. Call only the tools this message needs: one record per transaction, then reply." });
      continue;
    }
    if (!calls.length) {
      const text = stripThinking(res.message.content);
      if (text) return finish(text);
      failures += 1;
      messages.push({ role: "user", content: "Reply to the owner in one to three short sentences." });
      continue;
    }
    messages.push({ role: "assistant", content: res.message.content || "", tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: c.function })) });

    let replyText = null;
    const writes = proposals.length > 0 || calls.some((c) => WRITE_TOOLS.has(c.function?.name));
    for (const call of calls) {
      const name = call.function?.name;
      let args;
      try {
        args = normaliseArgs(name, JSON.parse(call.function?.arguments || "{}"));
      } catch {
        args = null;
      }
      let result;
      if (!args || !TOOLS.some((t) => t.function.name === name)) {
        failures += 1;
        result = { error: `The call to ${name || "an unknown tool"} could not be read. Use one of the tools with valid JSON arguments.` };
      } else if (WRITE_TOOLS.has(name)) {
        const key = `${name}:${JSON.stringify(args)}`;
        let rateNote = null;
        if (args.rate && !numbersIn(message).has(Number(args.rate))) delete args.rate;
        const code = name === "record_sale" && args.paid_amount ? currencyCode(args.paid_currency) : "USD";
        const stale = fromLatestMessage(name, args, message, photo, working);
        if (stale) {
          failures += 1;
          result = { error: stale };
        } else if (name === "record_sale" && !saysHowPaid(message) && !image) {
          result = { question: "How did the customer pay: cash, mobile money or on credit?" };
        } else if (code === null) {
          result = { question: `Which currency was that, ZiG, rand, pula or kwacha?` };
        } else if (code !== "USD" && !args.rate) {
          const r = rates ? await rates(code, working.today) : { error: "Live exchange rates are switched off on this copy." };
          trace.push(...(r.trace || []));
          if (r.error) result = { question: r.error };
          else {
            const main = (r.checks?.sources || []).find((x) => x.url === r.url) || {};
            const fx = { source: r.source, url: r.url, asOf: r.asOf, kind: r.kind, readAt: main.readAt, fingerprint: main.fingerprint, crossChecked: Boolean(r.checks?.crossChecked), sources: r.checks?.sources || [] };
            Object.assign(args, { rate: r.unitsPerUsd, paid_currency_name: r.name, rate_note: `${r.source}${r.asOf ? `, ${r.asOf}` : ""}`, rate_source: fx });
            rateNote = { ...fx, unitsPerUsd: r.unitsPerUsd, currency: r.name };
          }
        } else if (code !== "USD") {
          args.paid_currency_name = currencyCode(args.paid_currency) === "ZIG" ? "ZiG" : args.paid_currency;
          args.rate_note = "the rate you gave";
        }
        if (!result && seen.has(key)) {
          result = { ok: true, note: "Already recorded above." };
        } else if (!result) {
          seen.add(key);
          const built = BUILDERS[name](working, args);
          const again =
            built.ok &&
            built.entry &&
            proposals.find(
              (p) =>
                p.tool === name &&
                ((p.summary === built.entry.memo && p.amount === built.entry.amount) ||
                  // a delivery already proposed in full, called again for some of its lines
                  (name === "record_stock_in" && p.entry.party === built.entry.party && built.entry.stock.every((s) => p.entry.stock.some((q) => q.item === s.item && q.qty === s.qty)))),
            );
          if (!built.ok) result = { question: built.question };
          else if (again) result = { ok: true, note: "Already recorded above." };
          else {
            const proposal = { id: `p${proposals.length + 1}-${Date.now().toString(36)}`, tool: name, warnings: built.warnings || [], ...(rateNote ? { rate: rateNote } : {}) };
            if (built.entry) {
              working = applyEntry(working, built.entry);
              Object.assign(proposal, { entry: built.entry, summary: built.entry.memo, amount: built.entry.amount });
            } else if (built.price) {
              Object.assign(proposal, { price: built.price, summary: `New price for ${built.price.name}: ${money(built.price.to)}` });
            }
            proposals.push(proposal);
            result = { ok: true, will_record: proposal.summary, ...(proposal.amount ? { amount: money(proposal.amount) } : {}), warnings: proposal.warnings };
          }
        }
      } else if (name === "reply") {
        const text = stripThinking(args.text);
        if (!proposals.length && /\b(recorded|added|saved|logged)\b/i.test(text) && round < 2) {
          failures += 1;
          result = { error: "Nothing was recorded. Call the record tool for each transaction, then reply." };
        } else {
          replyText = text;
          result = { ok: true };
        }
      } else if (name === "get_exchange_rate" && !CURRENCY_WORDS.test(message)) {
        failures += 1;
        result = { error: "The owner's latest message names no other currency. Look up a rate only when the owner was paid in ZiG, rand, pula or kwacha, or asks for a rate." };
      } else if (name === "get_exchange_rate") {
        const code = currencyCode(args.currency);
        const r = code && code !== "USD" && rates ? await rates(code, working.today) : { error: "Ask about ZiG, rand, pula or kwacha." };
        trace.push(...(r.trace || []));
        if (!r.error) lookups.push({ currency: r.name, unitsPerUsd: r.unitsPerUsd, asOf: r.asOf, kind: r.kind, source: r.source, url: r.url, sources: r.checks?.sources || [] });
        result = r.error
          ? { error: r.error }
          : { currency: r.name, units_per_us_dollar: r.unitsPerUsd, as_of: r.asOf, kind: r.kind, source: r.source, checked_on_page: true, cross_checked_with: (r.checks?.sources || []).filter((x) => x.host !== r.source).map((x) => `${x.host} ${x.unitsPerUsd} (${x.asOf})`) };
      } else if (name === "get_figures" && writes) {
        result = { error: "This message records transactions. Reply with what will be recorded and any warning; figures are for the owner's questions." };
      } else if (name === "get_figures") {
        result = figures(working, args.about);
      } else if (name === "ask_analyst" && proposals.length) {
        result = { error: "This message records transactions. Reply briefly to confirm them; the analyst answers only the owner's questions." };
      } else if (name === "ask_analyst") {
        const a = await askAnalyst({ chat, models, books: working, question: String(args.question || message).slice(0, 400), ownerWords: message });
        trace.push(a.trace);
        if (a.text) return done(a.text, { answeredBy: models.analyst.label });
        result = { error: "The analyst could not answer. Answer briefly yourself." };
      } else if (name === "close_day" && !numbersIn(message).has(Number(args.counted_cash))) {
        failures += 1;
        result = { error: "The owner's latest message gives no counted cash. Call close_day only when the owner says what they counted in the till." };
      } else if (name === "close_day") {
        const c = await closeDay({ chat, models, books: working, counted: args.counted_cash, ownerWords: message });
        if (c.question) result = { question: c.question };
        else {
          trace.push(c.trace);
          if (c.count.entry) {
            proposals.push({ id: `p${proposals.length + 1}-${Date.now().toString(36)}`, tool: "close_day", entry: c.count.entry, summary: c.count.entry.memo, amount: c.count.entry.amount, warnings: [] });
          }
          const till = { expected: c.count.expected, counted: c.count.counted, diff: c.count.diff };
          if (c.text) return done(c.text, { answeredBy: models.closer.label, till });
          result = { till: { expected: money(till.expected), counted: money(till.counted), difference: money(till.diff) } };
        }
      }
      if (result?.question) questions.push(result.question);
      grounds.push(JSON.stringify(result));
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }

    // A question from the ledger reaches the owner even when the model's reply skips it.
    if (replyText) return finish(replyText);
    if (truncated && proposals.length) return done(confirmation(proposals, questions));
    if (failures >= 2 && !escalated) {
      model = models.analyst;
      escalated = true;
    }
  }
  return done(proposals.length ? "I've prepared the records above. Tap to confirm each one." : "Sorry, I could not work that out. Could you say it another way?");
}
